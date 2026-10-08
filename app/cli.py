import argparse
import asyncio

from app.core.config import settings
from app.core.redis import get_redis
from app.repositories.user import UserRepository


async def run(args: argparse.Namespace) -> None:
    users = UserRepository(get_redis())
    if args.command == "add":
        if args.team not in settings.TEAMS:
            raise SystemExit(f"Unknown team '{args.team}'. Teams: {', '.join(settings.TEAMS)}")
        token = await users.create(args.name, args.team)
        print(f"{args.name} ({args.team}) token, shown once:\n{token}")
    elif args.command == "remove":
        print("removed" if await users.remove(args.name) else "no such user")
    else:
        for user in await users.all():
            print(f"{user.team:10} {user.name}")
    await get_redis().aclose()


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description="Manage handoff users and tokens")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add", help="create a user or rotate their token")
    add.add_argument("name")
    add.add_argument("team")
    remove = commands.add_parser("remove", help="delete a user and revoke their token")
    remove.add_argument("name")
    commands.add_parser("list", help="list users")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
