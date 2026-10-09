"""Private dashboard credentials: Windows Credential Manager or process memory.

Only the native Windows credential service persists keys. No fallback writes a
key to a file, environment variable, database, or browser storage.
"""
from __future__ import annotations

import ctypes
import hashlib
import os
import sys
from pathlib import Path


class CredentialStoreError(Exception):
    """Deliberately generic: native error details must not contain credentials."""


def credential_target(database: str | Path) -> str:
    canonical = os.path.normcase(str(Path(database).resolve()))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return "marketapp-rent:dashboard:marketapp:v1:" + digest


def valid_api_key(value) -> bool:
    return (isinstance(value, str) and 1 <= len(value) <= 512
            and all(33 <= ord(character) <= 126 for character in value)
            and not value.casefold().startswith("bearer"))


class SessionOnlyCredentialStore:
    available = False

    def read(self, target):
        return None

    def write(self, target, key):
        raise CredentialStoreError("Secure credential storage is unavailable")

    def delete(self, target):
        return None


class UnavailableWindowsCredentialStore(SessionOnlyCredentialStore):
    # A native service initialization failure does not prove that its previously
    # saved target is absent. Do not promise a session-only replacement/removal.
    persisted_state_unknown = True

    def delete(self, target):
        raise CredentialStoreError("Secure credential storage is unavailable")


class WindowsCredentialStore:
    """Generic current-user credentials, persistent only on this computer.

    Native ABI: https://learn.microsoft.com/windows/win32/api/wincred/ns-wincred-credentialw
    """
    available = True

    def __init__(self):
        if sys.platform != "win32":
            raise CredentialStoreError("Secure credential storage is unavailable")
        from ctypes import wintypes

        class Credential(ctypes.Structure):
            _fields_ = [
                ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR),
            ]

        self._credential = Credential
        self._pointer = ctypes.POINTER(Credential)
        self._api = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
        self._api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(self._pointer)]
        self._api.CredReadW.restype = wintypes.BOOL
        self._api.CredWriteW.argtypes = [self._pointer, wintypes.DWORD]
        self._api.CredWriteW.restype = wintypes.BOOL
        self._api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
        self._api.CredDeleteW.restype = wintypes.BOOL
        self._api.CredFree.argtypes = [ctypes.c_void_p]
        self._api.CredFree.restype = None

    def read(self, target):
        pointer = self._pointer()
        if not self._api.CredReadW(target, 1, 0, ctypes.byref(pointer)):
            if ctypes.get_last_error() == 1168:  # ERROR_NOT_FOUND
                return None
            raise CredentialStoreError("Secure credential storage could not be read")
        try:
            item = pointer.contents
            if item.CredentialBlobSize > 512:
                raise CredentialStoreError("Stored credential is invalid")
            value = ctypes.string_at(item.CredentialBlob, item.CredentialBlobSize).decode("ascii")
            if not valid_api_key(value):
                raise CredentialStoreError("Stored credential is invalid")
            return value
        except (ValueError, UnicodeError):
            raise CredentialStoreError("Stored credential is invalid") from None
        finally:
            if pointer:
                item = pointer.contents
                if item.CredentialBlob and item.CredentialBlobSize:
                    ctypes.memset(item.CredentialBlob, 0, item.CredentialBlobSize)
                self._api.CredFree(pointer)

    def write(self, target, key):
        if not valid_api_key(key):
            raise CredentialStoreError("Credential is invalid")
        buffer = ctypes.create_string_buffer(key.encode("ascii"))
        item = self._credential()
        item.Type, item.Persist = 1, 2  # GENERIC, LOCAL_MACHINE (same current user)
        item.TargetName, item.UserName = target, "marketapp-rent"
        item.CredentialBlobSize = len(key)
        item.CredentialBlob = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))
        try:
            if not self._api.CredWriteW(ctypes.byref(item), 0):
                raise CredentialStoreError("Credential could not be saved securely")
        finally:
            ctypes.memset(buffer, 0, len(buffer))

    def delete(self, target):
        if not self._api.CredDeleteW(target, 1, 0) and ctypes.get_last_error() != 1168:
            raise CredentialStoreError("Stored credential could not be removed")


def default_credential_store():
    if sys.platform == "win32":
        try:
            return WindowsCredentialStore()
        except (OSError, CredentialStoreError):
            return UnavailableWindowsCredentialStore()
    return SessionOnlyCredentialStore()


class DashboardCredentials:
    """Runtime state; callers serialize changes with job submission."""

    def __init__(self, database, external_key="", store=None):
        self.store = store if store is not None else default_credential_store()
        self.target = credential_target(database)
        self.key = external_key
        self.source = "environment" if external_key else "none"
        self.storage_available = bool(self.store.available)
        self.persisted_state_unknown = bool(getattr(self.store, "persisted_state_unknown", False))
        if not external_key and self.storage_available:
            try:
                saved = self.store.read(self.target)
                if saved is not None and not valid_api_key(saved):
                    raise CredentialStoreError("Stored credential is invalid")
                if saved:
                    self.key, self.source = saved, "secure_store"
            except (CredentialStoreError, OSError):
                self.storage_available = False
                self.persisted_state_unknown = True

    def status(self, *, network_enabled, active_job=False):
        reason = ("external_configuration" if self.source == "environment" else
                  "active_job" if active_job else
                  "secure_store_unavailable" if not self.storage_available else None)
        result = {"configured": bool(self.key), "source": self.source,
                  "persistent_storage_available": self.storage_available,
                  "network_enabled": bool(network_enabled),
                  "can_manage": (self.source != "environment" and not active_job
                                 and not (self.persisted_state_unknown and not self.store.available)),
                  "restart_required": bool(self.key) and not network_enabled}
        if reason:
            result["reason"] = reason
        return result

    def save(self, key, persist):
        if self.source == "environment" or not valid_api_key(key) or type(persist) is not bool:
            raise ValueError("Credential change is not permitted")
        if persist:
            if not self.storage_available:
                raise CredentialStoreError("Secure credential storage is unavailable")
            self.store.write(self.target, key)
        elif self.source == "secure_store" or self.persisted_state_unknown:
            # A session-only replacement must not resurrect an older key at restart.
            self.store.delete(self.target)
        self.persisted_state_unknown = False
        self.key, self.source = key, "secure_store" if persist else "session"

    def delete(self):
        if self.source == "environment":
            raise ValueError("Credential change is not permitted")
        if self.source == "secure_store" or self.persisted_state_unknown:
            self.store.delete(self.target)
        self.persisted_state_unknown = False
        self.key, self.source = "", "none"
