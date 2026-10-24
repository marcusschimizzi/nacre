-- migrate:up
GRANT SELECT ON schema_migrations TO nacre_app;

-- migrate:down
REVOKE SELECT ON schema_migrations FROM nacre_app;
