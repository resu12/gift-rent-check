"""Loopback-only dashboard transport; collection and view logic stay independent."""
from __future__ import annotations

import csv
import io
import secrets
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .addresses import canonical_address
from .dashboard_jobs import JobStore, JobWorker, execute_job
from .discovery_config import DiscoverySettings
from .discovery_store import DiscoveryStore
from .reports import _cell
from .storage import Store


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: str | None = None
    resume_job_id: int | None = Field(default=None, ge=1)
    timeframe: str | None = None
    date_from: str | None = None
    date_to: str | None = None

    @model_validator(mode="after")
    def valid_operation(self):
        if (self.kind is None) == (self.resume_job_id is None):
            raise ValueError("Supply either kind or resume_job_id")
        if self.kind is not None and self.kind not in {"refresh", "discover", "collect", "prices", "rental_prices"}:
            raise ValueError("Unknown operation")
        if self.model_fields_set & {"timeframe", "date_from", "date_to"}:
            if self.kind not in {"prices", "rental_prices", "collect"}:
                raise ValueError("Only new collection jobs accept a timeframe; resume retains its saved window")
        if self.kind in {"prices", "rental_prices", "collect"}:
            from .pricing_window import dashboard_window
            dashboard_window(self.timeframe or "30d", self.date_from, self.date_to,
                             collect_history=self.kind in {"rental_prices", "collect"})
        return self


def choose_wallet(store, configured=None):
    if configured:
        return canonical_address(configured)
    runs = DiscoveryStore(store).runs()
    wallets = {run["wallet_address"] for run in runs}
    if len(wallets) == 1:
        return next(iter(wallets))
    if len(wallets) > 1:
        raise ValueError("Multiple wallets are stored; choose --wallet for the private dashboard")
    return None


def create_app(settings, discovery_settings=None, *, wallet=None, review_path=None,
               allow_network=False, static_dir=None, jobs_path=None, start_worker=True,
               execute=None):
    """Local development adapter. Do not expose it through a tunnel or public bind.

    Telegram Serverless will supply its own transport/authentication adapter;
    this module deliberately does not pretend localhost is a hosted deployment.
    """
    from .dashboard_view import build_dashboard

    discovery_settings = discovery_settings or DiscoverySettings()
    review_path = Path(review_path).resolve() if review_path else None
    if review_path and not review_path.is_dir():
        raise ValueError("Review directory does not exist")
    database = Path(settings.db_path).resolve()
    with Store(database) as store:
        store.connection.execute("PRAGMA journal_mode=WAL")
        selected_wallet = choose_wallet(store, wallet or settings.owner_address)
    jobs = JobStore(jobs_path or database.with_name(database.stem + ".dashboard.sqlite3"))
    csrf_token = secrets.token_urlsafe(32)
    static_dir = Path(static_dir or Path(__file__).parent / "dashboard_static").resolve()
    execute = execute or (lambda job: execute_job(job, jobs, settings, discovery_settings, review_path, worker.stop_event))
    worker = JobWorker(jobs, database, execute, (settings.token, discovery_settings.api_key))

    @asynccontextmanager
    async def lifespan(app):
        if start_worker and allow_network:
            worker.start()
        try:
            yield
        finally:
            worker.stop()

    app = FastAPI(title="Gift rental dashboard", docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=lifespan)
    app.state.jobs = jobs
    app.state.worker = worker
    app.state.csrf_token = csrf_token

    @app.middleware("http")
    async def local_access(request: Request, call_next):
        host = urlsplit("http://" + request.headers.get("host", "")).hostname
        if host not in {"127.0.0.1", "localhost", "::1", "testserver"}:
            return JSONResponse({"detail": "This dashboard accepts local connections only"}, status_code=403)
        client = request.client.host if request.client else None
        if client not in {"127.0.0.1", "::1", "testclient", None}:
            return JSONResponse({"detail": "Loopback access required"}, status_code=403)
        origin = request.headers.get("origin")
        expected_origin = f"{request.url.scheme}://{request.headers.get('host')}"
        if origin and origin != expected_origin:
            return JSONResponse({"detail": "Cross-origin access is disabled"}, status_code=403)
        if request.headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse({"detail": "Cross-site access is disabled"}, status_code=403)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if not secrets.compare_digest(request.headers.get("x-dashboard-csrf", ""), csrf_token):
                return JSONResponse({"detail": "Refresh the dashboard before submitting work"}, status_code=403)
            try:
                content_length = int(request.headers.get("content-length", "0"))
            except ValueError:
                return JSONResponse({"detail": "Invalid request length"}, status_code=400)
            if content_length > 4096:
                return JSONResponse({"detail": "Request is too large"}, status_code=413)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        return response

    @app.exception_handler(sqlite3.Error)
    async def local_database_error(request, exc):
        return JSONResponse({"detail": "Local data is temporarily unavailable; retry shortly"}, status_code=503)

    @app.exception_handler(ValueError)
    async def invalid_configuration(request, exc):
        # Configuration and path details are not sent to the client.
        return JSONResponse({"detail": "Stored data or dashboard configuration could not be read"}, status_code=422)

    @app.get("/api/health")
    def health():
        return {"status": "ok", "mode": "local", "network_enabled": allow_network}

    def view(pricing_source="listings", timeframe="30d", date_from=None, date_to=None, pricing_backdrop=None):
        from .pricing_window import dashboard_window
        try:
            if pricing_source not in {"listings", "rentals"}:
                raise ValueError("Unknown pricing source")
            if pricing_backdrop not in (None, "Black"):
                raise ValueError("Pricing backdrop must be Black or omitted")
            dashboard_window(timeframe, date_from, date_to)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        with Store(database) as store:
            store.connection.execute("PRAGMA query_only=ON")
            result = build_dashboard(store, selected_wallet, review_path, pricing_source=pricing_source, timeframe=timeframe, date_from=date_from, date_to=date_to, pricing_backdrop=pricing_backdrop)
        result["capabilities"] = {
            "mode": "local", "network_enabled": allow_network,
            "marketapp_configured": bool(settings.token), "ton_configured": bool(discovery_settings.api_key),
            "wallet_configured": bool(selected_wallet), "csrf_token": csrf_token,
            "telegram_hosting": "early access available; separate Serverless prototype",
            "marketapp_limits": {
                "max_attempts": settings.dashboard_max_attempts,
                "rolling_24h_attempts": settings.dashboard_daily_max_attempts,
                "run_seconds": settings.dashboard_run_seconds,
                "requests_per_second": min(1, settings.requests_per_second),
                **jobs.marketapp_usage(settings.dashboard_daily_max_attempts),
            },
        }
        return result

    @app.get("/api/dashboard")
    def dashboard_data(pricing_source: str = "listings", timeframe: str = "30d", date_from: str | None = None, date_to: str | None = None, pricing_backdrop: str | None = None):
        return view(pricing_source, timeframe, date_from, date_to, pricing_backdrop)

    @app.get("/api/jobs")
    def job_list():
        return {"jobs": jobs.list()}

    @app.get("/api/jobs/{job_id}")
    def job_detail(job_id: int):
        try:
            return jobs.get(job_id)
        except ValueError:
            raise HTTPException(404, "Job not found") from None

    @app.post("/api/jobs/{job_id}/stop", status_code=202)
    def stop_job(job_id: int):
        # Stopping local work remains available even if credentials or network
        # collection are disabled. The mutation still requires same-origin CSRF.
        try:
            return {"job": jobs.request_stop(job_id)}
        except ValueError:
            raise HTTPException(404, "Job not found") from None

    @app.post("/api/jobs", status_code=202)
    def submit_job(body: JobRequest):
        if not allow_network:
            raise HTTPException(409, "Network refresh is disabled. Start with --allow-network to enable manual refresh.")
        if not selected_wallet:
            raise HTTPException(409, "Configure a wallet before refreshing")
        # A resumed discovery may already have a catalog, but the user's UI
        # should never silently substitute cached catalog data for a new run.
        if not settings.token:
            raise HTTPException(409, "Configure MARKETAPP_API_TOKEN locally before starting refresh work")
        collection_window = None
        if body.kind in {"prices", "rental_prices", "collect"}:
            from .pricing_window import dashboard_window, window_metadata
            collection_window = window_metadata(dashboard_window(
                body.timeframe or "30d", body.date_from, body.date_to,
                collect_history=body.kind in {"rental_prices", "collect"},
            ))
        try:
            job, duplicate = jobs.enqueue(body.kind, selected_wallet, body.resume_job_id,
                                          collection_window=collection_window)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        return {"job": job, "deduplicated": duplicate}

    @app.get("/api/export.csv")
    def export_csv(pricing_source: str = "listings", timeframe: str = "30d", date_from: str | None = None, date_to: str | None = None, pricing_backdrop: str | None = None):
        content = io.StringIO(newline="")
        fields = [
            "name", "nft_address", "collection_name", "collection_address", "collection_conflict", "collection_addresses", "state", "display_state",
            "category", "automatic_membership", "membership_sources", "verification_method", "proof_badges",
            "price_per_day", "price_unit", "price_source", "price_observed_at", "price_is_historical", "observed_at", "market_observed_at",
            "rental_until", "holding_contract", "code_hash", "decoder_version", "reason",
            "recorded_rental_count", "rental_history_coverage", "rental_history_observed_at",
            "first_recorded_rental_at", "last_recorded_rental_at", "rental_history_excluded_counts", "rental_history_note",
            "review_source_filename", "review_method", "reviewed_at", "review_as_of", "review_stale",
            "model", "backdrop", "traits_source", "traits_observed_at", "trait_uncertainties",
            "recommended_price_per_day", "recommendation_basis", "recommendation_confidence", "recommendation_reason", "recommendation_unit",
            "collection_mean", "collection_samples", "model_mean", "model_samples", "model_black_mean", "model_black_samples",
            "pricing_warnings", "pricing_source", "pricing_timeframe", "pricing_window_from", "pricing_window_to", "pricing_timezone",
            "pricing_time_basis", "pricing_sample_unit", "pricing_semantics_version", "pricing_backdrop",
            "collection_distinct_nfts", "model_distinct_nfts", "model_black_distinct_nfts",
            "uncertainties",
        ]
        writer = csv.DictWriter(content, fieldnames=fields)
        writer.writeheader()
        for gift in view(pricing_source, timeframe, date_from, date_to, pricing_backdrop)["gifts"]:
            if pricing_backdrop and (gift.get("backdrop") or "").strip().casefold() != "black":
                continue
            pricing = gift.get("pricing", {})
            history = gift.get("rental_history", {})
            row = {**gift, "recommended_price_per_day": pricing.get("recommended_price_per_day"),
                   "recorded_rental_count": history.get("recorded_count"),
                   "rental_history_coverage": history.get("coverage"),
                   "rental_history_observed_at": history.get("observed_at"),
                   "first_recorded_rental_at": history.get("first_rental_at"),
                   "last_recorded_rental_at": history.get("last_rental_at"),
                   "rental_history_excluded_counts": history.get("excluded_counts", {}),
                   "rental_history_note": history.get("note"),
                   "recommendation_basis": pricing.get("basis"), "recommendation_confidence": pricing.get("confidence"),
                   "recommendation_reason": pricing.get("reason"), "recommendation_unit": pricing.get("unit", "GRAM/day"),
                   "pricing_warnings": pricing.get("warnings", [])}
            for key in ("source", "timeframe", "window_from", "window_to", "timezone", "time_basis", "sample_unit", "semantics_version", "backdrop"):
                row["pricing_" + key] = pricing.get(key)
            for cohort in ("collection", "model", "model_black"):
                row[cohort + "_distinct_nfts"] = pricing.get(cohort, {}).get("distinct_nft_count", pricing.get(cohort, {}).get("sample_count"))
                row[cohort + "_mean"] = pricing.get(cohort, {}).get("mean")
                row[cohort + "_samples"] = pricing.get(cohort, {}).get("sample_count")
            writer.writerow({key: _cell(key, row.get(key)) for key in fields})
        return Response("\ufeff" + content.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": 'attachment; filename="gift-portfolio.csv"'})

    @app.get("/{path:path}")
    def frontend(path: str):
        if path.startswith("api/") or "\\" in path or any(part.startswith(".") for part in path.split("/")):
            raise HTTPException(404, "Endpoint not found")
        requested = (static_dir / (path or "index.html")).resolve()
        if not requested.is_relative_to(static_dir):
            raise HTTPException(404, "File not found")
        if requested.is_file():
            return FileResponse(requested)
        if Path(path).suffix:
            raise HTTPException(404, "File not found")
        index = static_dir / "index.html"
        if not index.is_file():
            raise HTTPException(503, "Dashboard frontend has not been built. See the local dashboard setup instructions.")
        return FileResponse(index)

    return app


def serve(settings, discovery_settings, *, wallet=None, review_path=None, port=8765,
          allow_network=False):
    import uvicorn
    app = create_app(settings, discovery_settings, wallet=wallet, review_path=review_path,
                     allow_network=allow_network)
    print(f"Local dashboard: http://127.0.0.1:{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", access_log=False,
                proxy_headers=False)
