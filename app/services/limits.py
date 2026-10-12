import time
from collections import defaultdict, deque


class WriteCounter:
    def __init__(self) -> None:
        self.stamps: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, user: str, limit: int, window: float = 60.0) -> bool:
        now = time.monotonic()
        stamps = self.stamps[user]
        while stamps and stamps[0] <= now - window:
            stamps.popleft()
        if len(stamps) >= limit:
            return False
        stamps.append(now)
        return True
