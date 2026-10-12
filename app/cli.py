import argparse
import asyncio

import asyncpg

from app.core.config import settings
from app.core.database import async_session, engine
from app.repositories.user import UserRepository
from app.services.members import join_url


async def wait_for_database(attempts: int = 60) -> None:
    for attempt in range(attempts):
        try:
            connection = await asyncpg.connect(settings.listen_dsn, timeout=5)
        except (OSError, asyncpg.PostgresError, TimeoutError) as error:
            print(f"database not ready ({type(error).__name__}), retrying in 3s", flush=True)
            await asyncio.sleep(3)
        else:
            await connection.close()
            return
    raise SystemExit("The database did not answer")


async def run(args: argparse.Namespace) -> None:
    if args.command == "wait":
        await wait_for_database()
        return
    users = UserRepository(async_session)
    if args.command == "add":
        token = await users.create(args.name, args.team, args.admin)
        print(f"{args.name} ({args.team}) token, shown once:\n{token}")
    elif args.command == "invite":
        code, expires_at = await users.create_invite(args.team, args.admin, "cli", args.days)
        print(f"Single-use invite, valid until {expires_at:%Y-%m-%d %H:%M} UTC:\n{join_url(code)}")
    elif args.command == "admin":
        print("done" if await users.set_admin(args.name, not args.revoke) else "no such user")
    elif args.command == "remove":
        print("removed" if await users.remove(args.name) else "no such user")
    else:
        for user in await users.all():
            print(f"{user.team:10} {user.name}{'  (admin)' if user.is_admin else ''}")
    await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description="Manage handoff users and tokens")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add", help="create a user or replace their token, and print the token")
    add.add_argument("name")
    add.add_argument("team")
    add.add_argument("--admin", action="store_true")
    invite = commands.add_parser("invite", help="print a single-use link a newcomer joins with")
    invite.add_argument("team", nargs="?", help="the team they join; they choose when left out")
    invite.add_argument("--admin", action="store_true")
    invite.add_argument("--days", type=int, default=7)
    admin = commands.add_parser("admin", help="make a user an admin")
    admin.add_argument("name")
    admin.add_argument("--revoke", action="store_true")
    remove = commands.add_parser("remove", help="delete a user and revoke their token")
    remove.add_argument("name")
    commands.add_parser("list", help="list users")
    commands.add_parser("wait", help="wait until the database answers")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
