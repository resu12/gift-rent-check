"""Command line interface; collection and discovery are explicitly networked."""

import argparse
import logging
import sqlite3
from dataclasses import asdict, replace
from pathlib import Path

from .collector import collect
from .price_collection import collect_prices, collect_rental_prices
from .config import HISTORY_ORDERS, SORT_ORDERS, load_settings
from .discovery import discover
from .discovery_config import load_discovery_settings
from .logging_setup import configure_logging
from .reports import export_reports, status
from .storage import Store
from .util import canonical_json


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="marketapp-rent", description="Read-only Marketapp rental collector and TON wallet discovery",
    )
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--db", type=Path, help="SQLite path (default: data/marketapp.sqlite3)")
    subparsers = parser.add_subparsers(dest="command", required=True)
    importer = subparsers.add_parser("import-portfolio", help="Import declared portfolio addresses from CSV")
    importer.add_argument("csv", type=Path)
    collector = subparsers.add_parser("collect", help="Collect free GET endpoints with bounded requests")
    collector.add_argument("--resume", type=int, metavar="RUN_ID")
    collector.add_argument("--collection-address", action="append", dest="collection_addresses")
    for name in ("page-size", "max-pages", "max-collections", "max-attempts", "retry-attempts"):
        collector.add_argument("--" + name, type=int)
    for name in ("run-seconds", "requests-per-second", "timeout"):
        collector.add_argument("--" + name, type=float)
    collector.add_argument("--sort-by", choices=SORT_ORDERS)
    collector.add_argument("--order-by", choices=HISTORY_ORDERS)
    for name in ("model", "symbol", "backdrop"):
        collector.add_argument("--" + name)
    for command, help_text in (
        ("collect-prices", "Collect listing comparisons for portfolio collections, models, and exact Black backdrops"),
        ("collect-rental-prices", "Collect rental history for portfolio collection comparisons"),
    ):
        prices = subparsers.add_parser(command, help=help_text)
        prices.add_argument("--resume", type=int, metavar="RUN_ID")
        prices.add_argument("--wallet", help="Wallet whose portfolio supplies comparison targets")
        prices.add_argument("--review-directory", type=Path, help="Explicit supplemental review directory")
        prices.add_argument("--page-size", type=int, default=100 if command == "collect-prices" else None,
                            help="Comparison page size (default: 100; resume keeps its saved page size)")
        for name in ("max-pages", "max-attempts", "retry-attempts"):
            prices.add_argument("--" + name, type=int)
        for name in ("run-seconds", "requests-per-second", "timeout"):
            prices.add_argument("--" + name, type=float)
    discovery = subparsers.add_parser("discover-wallet", help="Discover and verify wallet gifts through read-only TON queries")
    discovery.add_argument("--wallet", help="Mainnet TON wallet (defaults to MARKETAPP_OWNER_ADDRESS on new runs)")
    discovery.add_argument("--resume", type=int, metavar="DISCOVERY_RUN_ID")
    for name in ("page-size", "batch-size", "max-pages", "max-attempts", "retry-attempts"):
        discovery.add_argument("--" + name, type=int)
    for name in ("run-seconds", "requests-per-second", "timeout"):
        discovery.add_argument("--" + name, type=float)
    reporter = subparsers.add_parser("report", help="Export local inspection CSVs; no network access")
    reporter.add_argument("--out", type=Path, default=Path("exports"))
    reporter.add_argument("--owner-address", help="Select TON ownership evidence and compare listing owners for this wallet")
    subparsers.add_parser("status", help="Show local coverage and resumable runs; no network access")
    dashboard = subparsers.add_parser("dashboard", help="Serve a private dashboard on this computer only")
    dashboard.add_argument("--wallet", help="Wallet to show; inferred only when exactly one is stored")
    dashboard.add_argument("--port", type=int, default=8765)
    dashboard.add_argument("--review-directory", type=Path, help="Explicit directory of dated supplemental review files")
    dashboard.add_argument("--allow-network", action="store_true", help="Enable manual refresh jobs; does not start a scan or schedule")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    configure_logging()
    logger = logging.getLogger(__name__)
    token = ""
    try:
        settings = load_settings(args.env_file)
        token = settings.token
        configure_logging(token)
        overrides = {key: getattr(args, key) for key in (
            "page_size", "max_pages", "max_collections", "max_attempts", "retry_attempts",
            "run_seconds", "requests_per_second", "timeout", "sort_by", "order_by",
        ) if getattr(args, key, None) is not None}
        if args.db is not None:
            overrides["db_path"] = args.db
        if args.command == "collect-rental-prices" and args.page_size is None:
            overrides["page_size"] = 100
        discovery_settings = None
        if args.command == "discover-wallet":
            discovery_settings = load_discovery_settings(args.env_file)
            configure_logging(token, discovery_settings.api_key)
            discovery_overrides = {key: getattr(args, key) for key in (
                "page_size", "batch_size", "max_pages", "max_attempts", "retry_attempts",
                "run_seconds", "requests_per_second", "timeout",
            ) if getattr(args, key, None) is not None}
            discovery_settings = replace(discovery_settings, **discovery_overrides)
            overrides = {"db_path": args.db} if args.db is not None else {}
        settings = replace(settings, **overrides)
        if args.command == "dashboard":
            if not 1024 <= args.port <= 65535:
                raise ValueError("Dashboard port must be between 1024 and 65535")
            try:
                from .dashboard import serve
            except ImportError:
                raise ValueError("Install the dashboard dependencies: python -m pip install -e '.[dashboard]'") from None
            discovery_settings = load_discovery_settings(args.env_file)
            configure_logging(token, discovery_settings.api_key)
            serve(settings, discovery_settings, wallet=args.wallet, review_path=args.review_directory,
                  port=args.port, allow_network=args.allow_network)
            return 0
        # Missing credentials should not create an empty database as a side effect.
        if args.command in {"collect", "collect-prices", "collect-rental-prices"} and not settings.token:
            raise ValueError("Set MARKETAPP_API_TOKEN in your local .env before collecting")
        if args.command == "discover-wallet" and args.resume is None:
            if not settings.token:
                raise ValueError("Set MARKETAPP_API_TOKEN before starting discovery to refresh the collection catalog")
            if not (args.wallet or settings.owner_address):
                raise ValueError("Supply --wallet or set MARKETAPP_OWNER_ADDRESS before starting discovery")
        with Store(settings.db_path) as store:
            if args.command == "import-portfolio":
                print(canonical_json(store.import_portfolio(args.csv)))
            elif args.command == "status":
                print(canonical_json(status(store)))
            elif args.command == "report":
                paths = export_reports(store, args.out, args.owner_address or settings.owner_address)
                print(canonical_json({"reports": [str(path.resolve()) for path in paths]}))
            elif args.command in {"collect-prices", "collect-rental-prices"}:
                from .dashboard_view import build_dashboard
                from .discovery_store import DiscoveryStore
                wallet = args.wallet or settings.owner_address
                if not wallet and args.resume is None:
                    wallets = {run["wallet_address"] for run in DiscoveryStore(store).runs()}
                    if len(wallets) > 1:
                        raise ValueError("Multiple wallets are stored; choose --wallet for price comparisons")
                    wallet = next(iter(wallets), None)
                gifts = build_dashboard(store, wallet, args.review_directory)["gifts"] if args.resume is None else None
                price_collector = collect_rental_prices if args.command == "collect-rental-prices" else collect_prices
                price_options = {}
                if args.command == "collect-rental-prices" and args.page_size is not None:
                    price_options["explicit_stream_options"] = {"page_size": args.page_size}
                result = price_collector(store, settings, gifts=gifts, resume_id=args.resume, **price_options)
                print(canonical_json(asdict(result)))
                return {"complete": 0, "partial": 3, "failed": 1}[result.state]
            elif args.command == "collect":
                explicit = {key: getattr(args, key) for key in (
                    "page_size", "sort_by", "order_by", "model", "symbol", "backdrop",
                ) if getattr(args, key) is not None}
                if args.collection_addresses is not None:
                    explicit["requested_collections"] = args.collection_addresses
                result = collect(
                    store, settings, resume_id=args.resume,
                    collection_addresses=args.collection_addresses,
                    model=args.model, symbol=args.symbol, backdrop=args.backdrop,
                    explicit_stream_options=explicit,
                )
                print(canonical_json(asdict(result)))
                return {"complete": 0, "partial": 3, "failed": 1}[result.state]
            elif args.command == "discover-wallet":
                wallet = args.wallet if args.resume is not None else (args.wallet or settings.owner_address)
                explicit = {key: getattr(args, key) for key in ("page_size", "batch_size") if getattr(args, key) is not None}
                result = discover(
                    store, discovery_settings, settings.token, wallet=wallet,
                    resume_id=args.resume, explicit_options=explicit,
                )
                print(canonical_json(asdict(result)))
                return {"complete": 0, "partial": 3, "failed": 1}[result.state]
        return 0
    except ValueError as exc:
        logger.error(str(exc), extra={"event": "configuration_error"})
        return 2
    except (OSError, sqlite3.Error) as exc:
        logger.error(str(exc), extra={"event": "local_error"})
        return 1
    except KeyboardInterrupt:
        logger.warning("Operation interrupted; committed collection or discovery work can be resumed", extra={"event": "interrupted"})
        return 3
