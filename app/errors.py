"""Errors the front can act on: a plain-French `detail` plus a stable machine-readable `code`.

    {"detail": "IDFM ne trouve aucun trajet sans marche à cette heure-là. Essayez une autre heure.", "code": "no_route"}

ApiError is an HTTPException, so `except HTTPException` keeps catching it; main.py turns it into that JSON.
Never put an upstream body, a stack trace or a key in `detail`: it is shown to the user as is.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import HTTPException


class ApiError(HTTPException):
    def __init__(self, status_code: int, detail: str, code: str, headers: Optional[Dict[str, str]] = None,
                 **extra: Any):
        super().__init__(status_code, detail, headers=headers)
        self.code = code
        self.extra = extra

    def body(self) -> Dict[str, Any]:
        return {"detail": self.detail, "code": self.code, **self.extra}
