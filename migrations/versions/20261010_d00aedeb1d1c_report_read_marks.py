"""report read marks and work sessions

Revision ID: d00aedeb1d1c
Revises: 686aacd6335e
Create Date: 2026-10-10 01:40:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = "d00aedeb1d1c"
down_revision = "686aacd6335e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reply_reads", sa.Column("report_version", sa.Integer(), server_default="0", nullable=False))
    op.add_column("reply_reads", sa.Column("session_id", sa.String(length=64), nullable=True))
    op.add_column("reply_reads", sa.Column("session_label", sa.String(length=80), nullable=True))
    op.execute(
        "UPDATE reply_reads SET report_version = reports.version FROM reports WHERE reports.id = reply_reads.report_id"
    )
    op.execute(
        """
        INSERT INTO reply_reads (user_name, report_id, reply_id, report_version)
        SELECT assignee, id, 0, version FROM reports WHERE assignee IS NOT NULL
        ON CONFLICT (user_name, report_id) DO UPDATE SET report_version = EXCLUDED.report_version
        """
    )


def downgrade() -> None:
    op.drop_column("reply_reads", "session_label")
    op.drop_column("reply_reads", "session_id")
    op.drop_column("reply_reads", "report_version")
