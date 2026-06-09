1. Quick health check

  docker compose ps
  # rithm-phase1-postgres-1   Up (healthy)

  2. Connect and poke around

  Since you don't have psql on your host, go through the container:
  # Interactive shell into the db
  docker compose exec postgres psql -U rithm_admin -d rithm-dev
  
  # Then inside psql:
  \dn                      -- 5 module schemas
  \dt identity.*           -- tables per schema
  \d catalog.tracks        -- full table definition (columns, constraints, indexes)
  \du                      -- roles (rithm_admin + 5 module roles)
  \q
  
  If you have a GUI client (TablePlus, DBeaver, pgAdmin), connect with:
  - Host localhost, port 5433 (not 5432 — that's your host Postgres)
  - DB rithm-dev, user rithm_admin, password dev_admin_pw_change_me
  
  3. Re-run the spec verification suite

  All the blocks in docs/postgres_local_setup.md §Verification work as written, just swap -d rithm → -d 
  rithm-dev. For example the role-isolation test:
  # Should return 0 (allowed):
  docker compose exec postgres psql -U rithm_identity -d rithm-dev -c "SELECT count(*) FROM 
  identity.users;"
  
  # Should print "permission denied" (blocked):
  docker compose exec postgres psql -U rithm_identity -d rithm-dev -c "SELECT count(*) FROM 
  catalog.tracks;"
  (Heads-up: block 7, the trigger DO test, fails as written even on a correct setup — now() is frozen
  within one transaction. I verified the trigger with two separate statements instead; it works.)

  4. Test through the API

  The api container is already connected to rithm-dev. Hit it:
  curl -s http://localhost:8080/healthz   # or whatever the health route is
  docker compose logs api --tail 30       # watch for asyncpg connection errors
  
  5. Test the reset path

  5. Test the reset path

  Prove the init scripts are reproducible:
  \q

  If you have a GUI client (TablePlus, DBeaver, pgAdmin), connect with:
  - Host localhost, port 5433 (not 5432 — that's your host Postgres)
  - DB rithm-dev, user rithm_admin, password dev_admin_pw_change_me

  3. Re-run the spec verification suite

  All the blocks in docs/postgres_local_setup.md §Verification work as written, just swap -d rithm → -d rithm-dev. For
  example the role-isolation test:
  # Should return 0 (allowed):
  docker compose exec postgres psql -U rithm_identity -d rithm-dev -c "SELECT count(*) FROM identity.users;"

  # Should print "permission denied" (blocked):
  docker compose exec postgres psql -U rithm_identity -d rithm-dev -c "SELECT count(*) FROM catalog.tracks;"
  (Heads-up: block 7, the trigger DO test, fails as written even on a correct setup — now() is frozen within one transaction.
  I verified the trigger with two separate statements instead; it works.)

  4. Test through the API

  The api container is already connected to rithm-dev. Hit it:
  curl -s http://localhost:8080/healthz   # or whatever the health route is
  docker compose logs api --tail 30       # watch for asyncpg connection errors

  5. Test the reset path

  Prove the init scripts are reproducible:
  docker compose down postgres
  docker volume rm rithm-phase1_rithm_pgdata
  docker compose up -d --wait postgres    # init re-runs from scratch → healthy
  This destroys only the new rithm-dev data — your old pgdata volume and host Postgres are untouched.
  # Interactive shell into the db
  docker compose exec postgres psql -U rithm_admin -d rithm-dev

  # Then inside psql:
  \dn                      -- 5 module schemas
  \dt identity.*           -- tables per schema
  \d catalog.tracks        -- full table definition (columns, constraints, indexes)
  \du                      -- roles (rithm_admin + 5 module roles)
  \q

  If you have a GUI client (TablePlus, DBeaver, pgAdmin), connect with:
  - Host localhost, port 5433 (not 5432 — that's your host Postgres)
  - DB rithm-dev, user rithm_admin, password dev_admin_pw_change_me

  3. Re-run the spec verification suite

  All the blocks in docs/postgres_local_setup.md §Verification work as written, just swap
  -d rithm → -d rithm-dev. For example the role-isolation test:
  # Should return 0 (allowed):
  docker compose exec postgres psql -U rithm_identity -d rithm-dev -c "SELECT count(*) FROM
  identity.users;"

  # Should print "permission denied" (blocked):
  docker compose exec postgres psql -U rithm_identity -d rithm-dev -c "SELECT count(*) FROM
  catalog.tracks;"
  (Heads-up: block 7, the trigger DO test, fails as written even on a correct setup — now()
  is frozen within one transaction. I verified the trigger with two separate statements
  instead; it works.)

  4. Test through the API

  The api container is already connected to rithm-dev. Hit it:
  curl -s http://localhost:8080/healthz   # or whatever the health route is
  docker compose logs api --tail 30       # watch for asyncpg connection errors

  5. Test the reset path

  Prove the init scripts are reproducible:
  docker compose down postgres
  docker volume rm rithm-phase1_rithm_pgdata
  docker compose up -d --wait postgres    # init re-runs from scratch → healthy
  This destroys only the new rithm-dev data — your old pgdata volume and host Postgres are
  untouched.


  The api container is already connected to rithm-dev. Hit it:
  curl -s http://localhost:8080/healthz   # or whatever the health route is
  docker compose logs api --tail 30       # watch for asyncpg connection errors

  5. Test the reset path

  Prove the init scripts are reproducible:
  docker compose down postgres
  docker volume rm rithm-phase1_rithm_pgdata
  docker compose up -d --wait postgres    # init re-runs from scratch → healthy
  This destroys only the new rithm-dev data — your old pgdata volume and host Postgres
  are untouched.

  If you want, I can also run a quick end-to-end check now (insert a user → job → track
  across schemas and read them back) to simulate real app writes.


  If you want, I can also run a quick end-to-end check now (insert a user → job → track
  across schemas and read them back) to simulate real app writes.


※ recap: Local Postgres setup is done: docker-compose now runs the rithm-dev db on port
  docker compose down postgres
  docker volume rm rithm-phase1_rithm_pgdata
  docker compose up -d --wait postgres    # init re-runs from scratch → healthy
  This destroys only the new rithm-dev data — your old pgdata volume and host Postgres
  are untouched.

