import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable

import asyncpg
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.schemas.report import Event
from app.schemas.user import User

logger = logging.getLogger(__name__)

RESYNC = {"type": "resync", "notify": False}
CHANNEL = "handoff_events"
LISTEN_CHECK_SECONDS = 15.0
NOTIFY = text("select pg_notify(:channel, :payload)")


class Subscriber:
    def __init__(self, user: User, session: str | None = None):
        self.user = user
        self.session = session
        self.queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=200)
        self.dropped = False

    def wants(self, event: Event) -> bool:
        return self.user.team in event.teams or self.user.name in (event.notify_users or [])

    def payload(self, event: Event) -> dict:
        is_actor = event.by_user == self.user.name
        is_addressed = event.notify_users is None or self.user.name in event.notify_users
        body = event.model_dump(mode="json", exclude={"teams", "notify_users"})
        return {**body, "notify": is_addressed and not is_actor}


class EventHub:
    def __init__(self, database: async_sessionmaker[AsyncSession], dsn: str):
        self.database = database
        self.dsn = dsn
        self.subscribers: list[Subscriber] = []
        self.left: dict[tuple[str, str], float] = {}
        self.closing = False
        self.listening = False

    async def notify(self, payload: str) -> None:
        async with self.database() as session, session.begin():
            await session.execute(NOTIFY, {"channel": CHANNEL, "payload": payload})

    async def publish(self, event: Event) -> None:
        try:
            await self.notify(event.model_dump_json())
        except Exception:
            logger.exception("event %s for report #%s was not published", event.type.value, event.id)

    def sessions(self, user: str) -> set[str]:
        cutoff = time.monotonic() - settings.SESSION_GRACE_SECONDS
        self.left = {who: at for who, at in self.left.items() if at >= cutoff}
        streaming = {s.session for s in self.subscribers if s.user.name == user and s.session}
        return streaming | {session for name, session in self.left if name == user}

    def expect(self, user: str, session: str) -> None:
        if session not in self.sessions(user):
            self.resync(user)
        self.left[(user, session)] = time.monotonic()

    def subscribe(self, user: User, session: str | None = None) -> Subscriber:
        own = [subscriber for subscriber in self.subscribers if subscriber.user.name == user.name]
        for oldest in own[: max(0, len(own) - settings.MAX_STREAMS_PER_USER + 1)]:
            self.drop(oldest)
        if session is not None and session not in self.sessions(user.name):
            self.resync(user.name)
        subscriber = Subscriber(user, session)
        self.subscribers.append(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: Subscriber) -> None:
        if subscriber not in self.subscribers:
            return
        self.subscribers.remove(subscriber)
        if subscriber.session is None or self.closing:
            return
        self.left[(subscriber.user.name, subscriber.session)] = time.monotonic()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.call_later(settings.SESSION_GRACE_SECONDS + 1, self.settle, subscriber.user.name, subscriber.session)

    def settle(self, user: str, session: str) -> None:
        if not self.closing and session not in self.sessions(user):
            self.resync(user)

    def drop(self, subscriber: Subscriber) -> None:
        subscriber.dropped = True
        self.unsubscribe(subscriber)
        self.push(subscriber, None)

    def push(self, subscriber: Subscriber, payload: dict | None) -> None:
        try:
            subscriber.queue.put_nowait(payload)
        except asyncio.QueueFull:
            subscriber.dropped = True
            self.unsubscribe(subscriber)

    def deliver(self, event: Event) -> None:
        for subscriber in list(self.subscribers):
            if subscriber.wants(event):
                self.push(subscriber, subscriber.payload(event))

    def resync(self, user: str | None = None) -> None:
        for subscriber in list(self.subscribers):
            if user is None or subscriber.user.name == user:
                self.push(subscriber, RESYNC)

    async def refresh_user(self, user: str | None) -> None:
        try:
            await self.notify(json.dumps({"refresh_user": user}))
        except Exception:
            logger.exception("refresh for %s was not published", user)

    def receive(self, raw: str) -> None:
        message = json.loads(raw)
        if "refresh_user" in message:
            self.resync(message["refresh_user"])
        else:
            self.deliver(Event.model_validate(message))

    def heard(self, connection: object, pid: int, channel: str, payload: str) -> None:
        try:
            self.receive(payload)
        except Exception:
            logger.exception("an event could not be delivered")

    def close(self) -> None:
        self.closing = True
        for subscriber in list(self.subscribers):
            self.push(subscriber, None)

    async def run(self) -> None:
        while not self.closing:
            connection = None
            try:
                connection = await asyncpg.connect(self.dsn, timeout=10)
                await connection.add_listener(CHANNEL, self.heard)
                self.listening = True
                self.resync()
                while not self.closing:
                    await asyncio.sleep(LISTEN_CHECK_SECONDS)
                    await connection.execute("select 1", timeout=10)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("event listener dropped, reconnecting")
                await asyncio.sleep(2)
            finally:
                self.listening = False
                if connection is not None:
                    connection.terminate()


async def stream(
    hub: EventHub, user: User, still_valid: Callable[[], Awaitable[bool]], session: str | None = None
) -> AsyncIterator[str]:
    subscriber = hub.subscribe(user, session)
    try:
        yield ": connected\n\n"
        while not hub.closing and not subscriber.dropped:
            try:
                payload = await asyncio.wait_for(subscriber.queue.get(), timeout=settings.SSE_HEARTBEAT_SECONDS)
            except TimeoutError:
                if not await still_valid():
                    break
                yield ": ping\n\n"
                continue
            if payload is None:
                break
            yield f"data: {json.dumps(payload)}\n\n"
    finally:
        hub.unsubscribe(subscriber)
