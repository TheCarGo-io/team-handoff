"""reports users replies marks events

Revision ID: 686aacd6335e
Revises:
Create Date: 2026-10-09 21:19:38.887635
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "686aacd6335e"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "events",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), nullable=False),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False),
        sa.Column("by_team", sa.String(length=32), nullable=False),
        sa.Column("by_user", sa.String(length=64), nullable=False),
        sa.Column("note", sa.Text(), server_default="", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_events_created_at"), "events", ["created_at"], unique=False)
    op.create_index(op.f("ix_events_report_id"), "events", ["report_id"], unique=False)
    op.create_table(
        "reports",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("project", sa.String(length=80), nullable=False),
        sa.Column("projects", postgresql.ARRAY(sa.String(length=80)), server_default="{}", nullable=False),
        sa.Column("from_team", sa.String(length=32), nullable=False),
        sa.Column("from_user", sa.String(length=64), nullable=False),
        sa.Column("to_team", sa.String(length=32), nullable=False),
        sa.Column("to_user", sa.String(length=64), nullable=True),
        sa.Column("priority", sa.String(length=10), nullable=False),
        sa.Column("due", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("assignee", sa.String(length=64), nullable=True),
        sa.Column("readiness", sa.String(length=20), server_default="ready", nullable=False),
        sa.Column("readiness_note", sa.Text(), nullable=True),
        sa.Column("delivery", sa.String(length=10), nullable=True),
        sa.Column("delivery_refs", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("related", postgresql.ARRAY(sa.Integer()), server_default="{}", nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("taken_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by", sa.String(length=64), nullable=True),
        sa.Column("status_before_closing", sa.String(length=16), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_reports_closed_at", "reports", ["closed_at"], unique=False)
    op.create_index("ix_reports_from_user_status", "reports", ["from_user", "status"], unique=False)
    op.create_index("ix_reports_projects", "reports", ["projects"], unique=False, postgresql_using="gin")
    op.create_index("ix_reports_to_team_status", "reports", ["to_team", "status"], unique=False)
    op.create_table(
        "users",
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("team", sa.String(length=32), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("name"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_table(
        "hidden_reports",
        sa.Column("user_name", sa.String(length=64), nullable=False),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_name", "report_id"),
    )
    op.create_table(
        "replies",
        sa.Column("id", sa.Integer(), sa.Identity(always=False), nullable=False),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("team", sa.String(length=32), nullable=False),
        sa.Column("user_name", sa.String(length=64), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_replies_report_id"), "replies", ["report_id"], unique=False)
    op.create_table(
        "reply_reads",
        sa.Column("user_name", sa.String(length=64), nullable=False),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("reply_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_name", "report_id"),
    )
    op.create_table(
        "report_items",
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("project", sa.String(length=80), nullable=True),
        sa.Column("readiness", sa.String(length=20), server_default="ready", nullable=False),
        sa.Column("done", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("done_by", sa.String(length=64), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("report_id", "position"),
    )


def downgrade() -> None:
    op.drop_table("report_items")
    op.drop_table("reply_reads")
    op.drop_index(op.f("ix_replies_report_id"), table_name="replies")
    op.drop_table("replies")
    op.drop_table("hidden_reports")
    op.drop_table("users")
    op.drop_index("ix_reports_to_team_status", table_name="reports")
    op.drop_index("ix_reports_projects", table_name="reports", postgresql_using="gin")
    op.drop_index("ix_reports_from_user_status", table_name="reports")
    op.drop_index("ix_reports_closed_at", table_name="reports")
    op.drop_table("reports")
    op.drop_index(op.f("ix_events_report_id"), table_name="events")
    op.drop_index(op.f("ix_events_created_at"), table_name="events")
    op.drop_table("events")
