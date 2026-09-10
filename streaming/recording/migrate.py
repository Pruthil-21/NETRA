"""Owner-role bootstrap and daily forward partition creation. Never drops evidence."""
import os
from pathlib import Path
import psycopg

with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=10) as connection:
    connection.execute(Path(__file__).with_name('schema.sql').read_text())
