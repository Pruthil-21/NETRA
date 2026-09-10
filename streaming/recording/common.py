import os
import uuid
from psycopg_pool import ConnectionPool
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import boto3
from botocore.config import Config


def database():
    return ConnectionPool(os.environ['DATABASE_URL'], min_size=1, max_size=8,
                          timeout=10, kwargs={'row_factory': dict_row, 'connect_timeout': 5,
                          'options': '-c statement_timeout=15000'})


def storage():
    return boto3.client('s3', endpoint_url=os.environ.get('S3_ENDPOINT_URL'),
        config=Config(connect_timeout=5, read_timeout=30,
                      retries={'max_attempts': 3, 'mode': 'standard'}))


def audit(conn, path, actor, action, details):
    conn.execute('INSERT INTO audit(path,id,actor,action,details) VALUES(%s,%s,%s,%s,%s)',
                 (path, uuid.uuid4(), actor, action, Jsonb(details)))
