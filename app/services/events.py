import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable

from redis.asyncio import Redis

from app.core.config import settings
from app.core.redis import key
from app.schemas.report import Event
from app.schemas.user import User

logger = logging.getLogger(__name__)

RESYNC = {"type": "resync", "notify": False}
LISTEN_TIMEOUT_SECONDS = 15.0


class Subscriber:
    def __init__(self, user: User):
        self.user = user
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
    def __init__(self, redis: Redis):
        self.redis = redis
        self.subscribers: list[Subscriber] = []
        self.closing = False
        self.listening = False

    async def publish(self, event: Event) -> None:
        try:
            await self.redis.publish(key("events"), event.model_dump_json())
        except Exception:
            logger.exception("event %s for report #%s was not published", event.type.value, event.id)

    def subscribe(self, user: User) -> Subscriber:
        own = [subscriber for subscriber in self.subscribers if subscriber.user.name == user.name]
        for oldest in own[: max(0, len(own) - settings.MAX_STREAMS_PER_USER + 1)]:
            self.drop(oldest)
        subscriber = Subscriber(user)
        self.subscribers.append(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: Subscriber) -> None:
        if subscriber in self.subscribers:
            self.subscribers.remove(subscriber)

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

    async def refresh_user(self, user: str) -> None:
        try:
            await self.redis.publish(key("events"), json.dumps({"refresh_user": user}))
        except Exception:
            logger.exception("refresh for %s was not published", user)

    def receive(self, raw: str) -> None:
        message = json.loads(raw)
        if "refresh_user" in message:
            self.resync(message["refresh_user"])
        else:
            self.deliver(Event.model_validate(message))

    def close(self) -> None:
        self.closing = True
        for subscriber in list(self.subscribers):
            self.push(subscriber, None)

    async def run(self) -> None:
        while not self.closing:
            try:
                async with self.redis.pubsub() as pubsub:
                    await pubsub.subscribe(key("events"))
                    self.listening = True
                    self.resync()
                    while not self.closing:
                        message = await pubsub.get_message(
                            ignore_subscribe_messages=True, timeout=LISTEN_TIMEOUT_SECONDS
                        )
                        if message is None:
                            await pubsub.ping()
                        elif message["type"] == "message":
                            self.receive(message["data"])
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("event listener dropped, reconnecting")
                await asyncio.sleep(2)
            finally:
                self.listening = False


async def stream(hub: EventHub, user: User, still_valid: Callable[[], Awaitable[bool]]) -> AsyncIterator[str]:
    subscriber = hub.subscribe(user)
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
