-- Event analytics schema, single-node edition (docker-compose / one VM).
-- The clustered version (ReplicatedMergeTree, ON CLUSTER, S3 tiering) is in
-- docs/architecture.md section 4; table and column names are identical so the
-- application code does not change when you scale out.
--
-- Requires ClickHouse 25.3+ (JSON type).

CREATE DATABASE IF NOT EXISTS analytics;

-- 1. Raw events --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS analytics.events
(
    app_id            UInt32,
    timestamp         DateTime64(3, 'UTC')           CODEC(Delta, ZSTD(1)),
    event             LowCardinality(String),
    event_uuid        UUID,
    distinct_id       String                         CODEC(ZSTD(3)),
    person_id         UUID,
    session_id        String                         CODEC(ZSTD(3)),

    url               String                         CODEC(ZSTD(3)),
    pathname          String                         CODEC(ZSTD(3)),
    referrer_domain   LowCardinality(String),
    utm_source        LowCardinality(String),
    utm_medium        LowCardinality(String),
    utm_campaign      String                         CODEC(ZSTD(3)),
    country_code      LowCardinality(String),
    region            LowCardinality(String),
    city              LowCardinality(String),
    device_type       LowCardinality(String),
    os                LowCardinality(String),
    browser           LowCardinality(String),
    app_version       LowCardinality(String),
    lib               LowCardinality(String),

    properties        JSON(max_dynamic_paths = 512)  CODEC(ZSTD(3)),

    retention_days    UInt16 DEFAULT 395,
    received_at       DateTime64(3, 'UTC')           CODEC(Delta, ZSTD(1)),
    inserted_at       DateTime DEFAULT now()         CODEC(Delta, ZSTD(1)),

    INDEX idx_uuid        event_uuid  TYPE bloom_filter(0.001) GRANULARITY 4,
    INDEX idx_distinct_id distinct_id TYPE bloom_filter(0.01)  GRANULARITY 4,
    INDEX idx_person_id   person_id   TYPE bloom_filter(0.01)  GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY (retention_days, toYYYYMM(timestamp))
ORDER BY (app_id, toDate(timestamp), event, cityHash64(distinct_id), timestamp)
SAMPLE BY cityHash64(distinct_id)
TTL toDateTime(timestamp) + toIntervalDay(retention_days) DELETE
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- 2. Ingest from Redpanda (Kafka API) ----------------------------------------

CREATE TABLE IF NOT EXISTS analytics.events_queue
(
    app_id UInt32, timestamp DateTime64(3, 'UTC'), event String, event_uuid UUID,
    distinct_id String, person_id UUID, session_id String,
    url String, pathname String, referrer_domain String,
    utm_source String, utm_medium String, utm_campaign String,
    country_code String, region String, city String,
    device_type String, os String, browser String, app_version String, lib String,
    properties String, retention_days UInt16, received_at DateTime64(3, 'UTC')
)
ENGINE = Kafka
SETTINGS kafka_broker_list       = 'redpanda:9092',
         kafka_topic_list        = 'events.raw',
         kafka_group_name        = 'clickhouse-events',
         kafka_format            = 'JSONEachRow',
         kafka_num_consumers     = 1,
         kafka_max_block_size    = 1048576,
         kafka_flush_interval_ms = 2000,
         kafka_handle_error_mode = 'stream';

CREATE TABLE IF NOT EXISTS analytics.ingest_errors
(
    ts        DateTime,
    topic     String,
    partition UInt64,
    offset    UInt64,
    raw       String CODEC(ZSTD(3)),
    error     String
)
ENGINE = MergeTree
ORDER BY ts
TTL ts + INTERVAL 30 DAY DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.events_queue_mv TO analytics.events AS
SELECT app_id, timestamp, event, event_uuid, distinct_id, person_id, session_id,
       url, pathname, referrer_domain, utm_source, utm_medium, utm_campaign,
       country_code, region, city, device_type, os, browser, app_version, lib,
       properties::JSON AS properties, retention_days, received_at
FROM analytics.events_queue
WHERE length(_error) = 0;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.events_queue_errors_mv TO analytics.ingest_errors AS
SELECT now() AS ts, _topic AS topic, _partition AS partition, _offset AS offset,
       _raw_message AS raw, _error AS error
FROM analytics.events_queue
WHERE length(_error) > 0;

-- 3. Rollups (filled on every insert into events) ----------------------------

CREATE TABLE IF NOT EXISTS analytics.events_hourly
(
    app_id          UInt32,
    hour            DateTime,
    event           LowCardinality(String),
    pathname        String,
    referrer_domain LowCardinality(String),
    utm_source      LowCardinality(String),
    country_code    LowCardinality(String),
    device_type     LowCardinality(String),
    browser         LowCardinality(String),
    events          SimpleAggregateFunction(sum, UInt64),
    users           AggregateFunction(uniqCombined64, String),
    sessions        AggregateFunction(uniqCombined64, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (app_id, hour, event, pathname, referrer_domain, utm_source, country_code, device_type, browser)
TTL hour + INTERVAL 25 MONTH DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.events_hourly_mv TO analytics.events_hourly AS
SELECT app_id, toStartOfHour(timestamp) AS hour, event, pathname, referrer_domain,
       utm_source, country_code, device_type, browser,
       count()                          AS events,
       uniqCombined64State(distinct_id) AS users,
       uniqCombined64State(session_id)  AS sessions
FROM analytics.events
GROUP BY app_id, hour, event, pathname, referrer_domain, utm_source, country_code, device_type, browser;

CREATE TABLE IF NOT EXISTS analytics.user_days
(
    app_id     UInt32,
    day        Date,
    person_id  UUID,
    events     SimpleAggregateFunction(sum, UInt64),
    first_seen SimpleAggregateFunction(min, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (app_id, day, person_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.user_days_mv TO analytics.user_days AS
SELECT app_id, toDate(timestamp) AS day, person_id,
       count() AS events, min(timestamp) AS first_seen
FROM analytics.events
GROUP BY app_id, day, person_id;

-- 4. Sessions (bounce rate, duration) ----------------------------------------

CREATE TABLE IF NOT EXISTS analytics.sessions
(
    app_id      UInt32,
    day         Date,
    session_id  String,
    start       SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    end         SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    pageviews   SimpleAggregateFunction(sum, UInt64),
    events      SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (app_id, day, session_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.sessions_mv TO analytics.sessions AS
SELECT app_id, toDate(timestamp) AS day, session_id,
       min(timestamp) AS start, max(timestamp) AS end,
       countIf(event = '$pageview') AS pageviews, count() AS events
FROM analytics.events
WHERE session_id != ''
GROUP BY app_id, day, session_id;

-- 5. Read-only user for the query API with tenant isolation -----------------
-- The API sets SQL_app_id on every query; a query without it fails instead of
-- returning every tenant's rows. (custom_settings_prefixes is set in
-- clickhouse/config.d/custom-settings.xml.)

CREATE USER IF NOT EXISTS query_api IDENTIFIED WITH sha256_password BY 'query_api_dev_password'
    SETTINGS readonly = 2, max_execution_time = 30, max_memory_usage = 4000000000;
GRANT SELECT ON analytics.* TO query_api;

CREATE ROW POLICY IF NOT EXISTS tenant_events ON analytics.events
    USING app_id = toUInt32(getSetting('SQL_app_id')) TO query_api;
CREATE ROW POLICY IF NOT EXISTS tenant_hourly ON analytics.events_hourly
    USING app_id = toUInt32(getSetting('SQL_app_id')) TO query_api;
CREATE ROW POLICY IF NOT EXISTS tenant_user_days ON analytics.user_days
    USING app_id = toUInt32(getSetting('SQL_app_id')) TO query_api;
CREATE ROW POLICY IF NOT EXISTS tenant_sessions ON analytics.sessions
    USING app_id = toUInt32(getSetting('SQL_app_id')) TO query_api;
