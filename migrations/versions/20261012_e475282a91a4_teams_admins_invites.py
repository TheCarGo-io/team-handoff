"""teams, admins and invites

Revision ID: e475282a91a4
Revises: d00aedeb1d1c
Create Date: 2026-10-12 18:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = "e475282a91a4"
down_revision = "d00aedeb1d1c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("is_admin", sa.Boolean(), server_default=sa.false(), nullable=False))
    op.add_column("users", sa.Column("announced_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table("teams", sa.Column("name", sa.String(length=32), nullable=False), sa.PrimaryKeyConstraint("name"))
    op.execute(
        """
        INSERT INTO teams (name)
        SELECT team FROM users UNION SELECT from_team FROM reports UNION SELECT to_team FROM reports
        """
    )
    op.create_table(
        "invites",
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("team", sa.String(length=32), nullable=True),
        sa.Column("is_admin", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_by", sa.String(length=64), nullable=True),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("code_hash"),
    )


def downgrade() -> None:
    op.drop_table("invites")
    op.drop_table("teams")
    op.drop_column("users", "announced_at")
    op.drop_column("users", "is_admin")
