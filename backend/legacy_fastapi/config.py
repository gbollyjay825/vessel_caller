"""Legacy environment-driven configuration (12-factor). All values overridable via
env vars prefixed VC_ or a .env file — see .env.example."""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VC_", env_file=".env", extra="ignore")

    app_name: str = "Vessel Caller API"
    environment: str = "development"           # development | production

    # Storage — SQLite by default; point at Postgres in prod via VC_DATABASE_URL
    database_url: str = "sqlite:///./vessel_caller.db"

    # Auth — MUST be overridden in production (a long random string)
    jwt_secret: str = "dev-insecure-change-me-in-production"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 12   # 12h

    # CORS — comma-separated list of allowed frontend origins
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    seed_on_startup: bool = True                 # seed demo data if the DB is empty

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
