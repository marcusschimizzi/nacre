# Migrations

Hand-written [dbmate](https://github.com/amacneil/dbmate) `.sql` files (`-- migrate:up` / `-- migrate:down`), applied in filename order. The first one, the spec §4 DDL, lands in task 2. The database client (`postgres`, i.e. postgres.js) is added then too, under `src/shared/db/`.
