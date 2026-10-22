import pytest

from app import limits


@pytest.fixture(autouse=True)
def _fresh_limits():
    """Call limits are per process: every test starts with empty counters."""
    limits.reset()
    yield
    limits.reset()
