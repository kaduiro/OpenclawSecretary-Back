ALTER TABLE oauth_sessions DROP CONSTRAINT IF EXISTS oauth_sessions_return_uri_check;
ALTER TABLE oauth_sessions ADD CONSTRAINT oauth_sessions_return_uri_check CHECK (
  return_uri ~ '^http://(127[.]0[.]0[.]1|\[::1\]):[0-9]{4,5}/callback(/[A-Za-z0-9_-]{43})?$'
);
