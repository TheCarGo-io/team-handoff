from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings

_connect_args = {"statement_cache_size": 0, "prepared_statement_cache_size": 0}

if settings.DB_USE_NULLPOOL:
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool, connect_args=_connect_args)
else:
    engine = create_async_engine(
        settings.DATABASE_URL,
        pool_pre_ping=True,
        pool_recycle=300,
        pool_size=settings.DB_POOL_SIZE,
        max_overflow=settings.DB_MAX_OVERFLOW,
        connect_args=_connect_args,
    )

async_session = async_sessionmaker(engine, expire_on_commit=False)
