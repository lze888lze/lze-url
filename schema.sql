CREATE TABLE IF NOT EXISTS access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  ip TEXT NOT NULL,
  ip_version TEXT DEFAULT '',
  country TEXT DEFAULT '',
  region TEXT DEFAULT '',
  city TEXT DEFAULT '',
  district TEXT DEFAULT '',
  isp TEXT DEFAULT '',
  country_code TEXT DEFAULT '',
  raw_region TEXT DEFAULT '',
  host TEXT DEFAULT '',
  subdomain TEXT DEFAULT '',
  path TEXT DEFAULT '',
  query TEXT DEFAULT '',
  method TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  referer TEXT DEFAULT '',
  cf_country TEXT DEFAULT '',
  cf_region TEXT DEFAULT '',
  cf_city TEXT DEFAULT '',
  cf_colo TEXT DEFAULT '',
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_access_logs_time ON access_logs(time);
CREATE INDEX IF NOT EXISTS idx_access_logs_ip ON access_logs(ip);
CREATE INDEX IF NOT EXISTS idx_access_logs_path ON access_logs(path);
CREATE INDEX IF NOT EXISTS idx_access_logs_subdomain ON access_logs(subdomain);
CREATE INDEX IF NOT EXISTS idx_access_logs_country_region ON access_logs(country, region);
