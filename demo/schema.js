const _types = `
-- Hybrid logical clock type
  CREATE TYPE hlc AS (
      physical_time bigint,
      logical_time int
  );

  -- Vector clock type
  CREATE DOMAIN vclock AS bigint[];

  -- Vector + HLC clocks
  CREATE TYPE vclock_and_hlc AS (
      lts vclock,
      pts hlc
  );

  -- Computes whether the vclock v1 happens before v2
  -- (i.e., each element of v1 is <= the corresponding element of v2)
  CREATE OR REPLACE FUNCTION vclock_lte(v1 vclock, v2 vclock) RETURNS bool AS $$
  BEGIN
      RETURN bool_and(coalesce(u1, 0) <= coalesce(u2, 0))
      FROM (
          SELECT unnest(v1) AS u1, unnest(v2) AS u2
      ) t;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Computes the pointwise max vclock of two vclocks
  CREATE OR REPLACE FUNCTION vclock_max(v1 vclock, v2 vclock) RETURNS vclock AS $$
  BEGIN
      RETURN array_agg(u)
      FROM (
          SELECT greatest(unnest(v1), unnest(v2)) AS u
      ) t;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Computes the next hybrid logical clock
  CREATE OR REPLACE FUNCTION next_hlc(curr hlc)
  RETURNS hlc AS $$
      DECLARE current_time_ms bigint;
      BEGIN
          -- first get the max between the old and the current
          SELECT currentTimeMillis() INTO current_time_ms;

          IF current_time_ms > (curr).physical_time THEN
              RETURN (current_time_ms, 1)::hlc;
          ELSE
              RETURN ((curr).physical_time, (curr).logical_time + 1)::hlc;
          END IF;
      END
  $$ LANGUAGE PLPGSQL;

  -- Represents a map entry
  CREATE TYPE mEntry AS (
      key varchar COLLATE "C",
      value varchar
  );

  -- Represents a map entry with multi-value register values
  CREATE TYPE mEntryMvr AS (
      key varchar COLLATE "C",
      value varchar[]
  );
`;

const _tables = `
-- Stores the local data
CREATE TABLE IF NOT EXISTS Local (
    id varchar COLLATE "C",
    key varchar COLLATE "C",
    type "char",
    data varchar,
    site int,
    lts vclock,
    pts hlc,
    op "char"
);
CREATE INDEX IF NOT EXISTS Local_idx ON Local (id, key );

-- Store the data from remote servers
CREATE TABLE Shared (
    id varchar COLLATE "C",
    key varchar COLLATE "C",
    type "char",
    data varchar,
    site int,
    lts vclock,
    pts hlc,
    op "char",
    seq serial
);
CREATE INDEX IF NOT EXISTS Shared_idx ON Shared (id, key);

-- Stores information about the cluster:
CREATE TABLE IF NOT EXISTS ClusterInfo (
    site_id integer,
    is_local boolean, -- whether this is the local site (true) or a remote one (false)
    addr varchar -- site address
);

-- Trigger to process local Shared inserts under the sync mode
CREATE OR REPLACE FUNCTION Shared_insert_local_sync_function() RETURNS trigger AS $$
BEGIN
    -- merge op
    PERFORM merge(new.id, new.key, new.type, new.data, new.site, new.lts, new.pts, new.op);

    RETURN new;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER Shared_insert_local_sync_trigger
AFTER INSERT ON Shared
FOR each row
EXECUTE FUNCTION Shared_insert_local_sync_function();

-- To be used to update the wall clock when receiving a remote insert and the read mode is 'all'.
CREATE OR REPLACE FUNCTION Shared_wall_clock_function() RETURNS trigger AS $$
BEGIN
    SET search_path TO 'public';

    -- update the wall clock
    PERFORM setval('WallClockSeq', greatest((new.pts).physical_time, (SELECT last_value FROM WallClockSeq)) , true);

    RETURN new;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER Shared_wall_clock_trigger
AFTER INSERT ON Shared
FOR each row
EXECUTE FUNCTION Shared_wall_clock_function();

-- Disable by default
ALTER TABLE Shared DISABLE TRIGGER Shared_wall_clock_trigger;

-- Used to control concurrent accesses to the same element
CREATE UNLOGGED TABLE StructureControl (
    id varchar PRIMARY KEY, -- structure identifier
    count bigint -- number of accesses
);
`;

const _sequences = `
-- Current logical time of the hybrid logical clock of this site
CREATE UNLOGGED SEQUENCE IF NOT EXISTS SiteHybridLogicalTime;

-- Last wall clock time seen
CREATE UNLOGGED SEQUENCE WallClockSeq;
`;

const _views = `
-- View that only considers the data in the Local table
CREATE VIEW DataLocal AS
    SELECT *, ctid
    FROM Local;

-- Auxiliary view that unions the Local and Shared rows
CREATE VIEW LocalAndShared AS
    SELECT id, key, type, data, site, lts, pts, op, ctid
    FROM Local
    UNION ALL
    SELECT id, key, type, data, site, lts, pts, op, ctid
    FROM Shared;

-- View that shows the most recent data from the Local and Shared tables.
CREATE VIEW DataAll AS
    SELECT id, key, type, data, site, lts, pts, op, ctid
    FROM (
        WITH potential_max AS (
            WITH maxes AS not materialized (
                SELECT id, key, (
                    SELECT array [max(lts[1])]
                    FROM LocalAndShared
                    WHERE id = t_.id AND key = t_.key
                ) m
                FROM (
                    SELECT DISTINCT id, key
                    FROM LocalAndShared
                ) t_
            )
            SELECT maxes.id, maxes.key, type, data, site, lts, pts, op, ctid
            FROM LocalAndShared, maxes
            WHERE LocalAndShared.id = maxes.id AND LocalAndShared.key = maxes.key
                AND lts[1] = maxes.m[1]
        )
        SELECT t1.*, NOT vclock_lte(t1.lts, t2.lts) OR t1.lts = t2.lts lte
        FROM potential_max t1
        JOIN LocalAndShared t2
            ON t1.id = t2.id AND t1.key = t2.key
    ) t
    GROUP BY id, key, type, data, site, lts, pts, op, ctid
    HAVING bool_and(lte) = true;

-- View with the current visible data (set to read from Data_Local by default)
CREATE VIEW Data AS
    SELECT *
    FROM DataLocal;

-- Rule to redirect inserts to the Data table to the Shared table
CREATE RULE Data_insert_rule AS
    ON INSERT TO Data
    DO INSTEAD INSERT INTO Shared VALUES(new.id, new.key, new.type, new.data, new.site, new.lts, new.pts, new.op, default);

-- View with all readable rows, to aid the timestamp computation
-- (defaults to only the Local table from sync writes; with async writes it considers both Local and Shared)
CREATE VIEW AllRows AS
    SELECT *
    FROM Local;
`;

const _functions = `
-- Returns the current time in milliseconds since epoch
CREATE OR REPLACE FUNCTION currentTimeMillis() RETURNS bigint AS $$
BEGIN
    RETURN round(extract(epoch FROM clock_timestamp()) * 1000);
END;
$$ LANGUAGE PLPGSQL;


-- Returns the site's identifier
CREATE OR REPLACE FUNCTION siteId() RETURNS int AS $$
BEGIN
    RETURN site_id
    FROM ClusterInfo
    WHERE is_local;
END;
$$ LANGUAGE PLPGSQL;


-- Returns the current number of sites
CREATE OR REPLACE FUNCTION nSites() RETURNS int AS $$
BEGIN
    SELECT count(*)
    FROM ClusterInfo;
END;
$$ LANGUAGE PLPGSQL;


-- Returns the initial logical timestamp (all zeros)
CREATE OR REPLACE FUNCTION initialLogicalTime() RETURNS vclock AS $$
BEGIN
    SELECT array_agg(0)
    FROM (
        SELECT generate_series(1, (SELECT nSites()))
    ) t;
END;
$$ LANGUAGE PLPGSQL;


-- Initializes the site's information
CREATE OR REPLACE FUNCTION initSite(site_id_ integer) RETURNS boolean AS $$
    BEGIN
        PERFORM *
        FROM ClusterInfo
        WHERE is_local;

        IF NOT FOUND THEN
            INSERT INTO ClusterInfo
            VALUES (site_id_, true, '-');

            CREATE INDEX ON Local ((lts[1]));

            RETURN true;
        ELSE
            RAISE EXCEPTION 'Site already initialized.';
            RETURN false;
        END IF;
    END
$$ LANGUAGE PLPGSQL;


-- Adds a remote site to the cluster.
CREATE OR REPLACE FUNCTION addRemoteSite(site_id_ integer) RETURNS boolean AS $$
    DECLARE next_lts varchar[];
            max_lts varchar[];
            match_lts varchar[];
            n_sites integer;
    BEGIN
        PERFORM *
        FROM ClusterInfo
        WHERE is_local;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Site not initialized.';
        END IF;

        PERFORM *
        FROM ClusterInfo
        WHERE site_id = site_id_;

        IF FOUND THEN
            RAISE EXCEPTION 'Site already exists.';
        END IF;

        INSERT INTO ClusterInfo
        VALUES (site_id_, false,'-');

        -- update views

        SELECT array_agg(format('coalesce(max(lts[%s]), 0)' || (CASE WHEN site_id = siteId() THEN '+ 1' ELSE '' END), site_id) ORDER BY site_id) INTO next_lts
        FROM ClusterInfo;

        SELECT array_agg(format('max(coalesce(lts[%s], 0))', site_id) ORDER BY site_id) INTO max_lts
        FROM ClusterInfo;

        EXECUTE format(
            'CREATE OR REPLACE FUNCTION nextTimestamp(id_ varchar) RETURNS vclock_and_hlc AS $D$
            BEGIN
                RETURN (
                    WITH T AS (
                        SELECT array [%s] as lts,
                            coalesce((SELECT (last_value, 0)::hlc FROM WallClockSeq), (0, 0)::hlc) as pts,
                            round(extract(epoch FROM clock_timestamp()) * 1000) as curr_time
                        FROM AllRows
                        where id = id_
                    )
                    SELECT (lts,
                        CASE WHEN curr_time > (T.pts).physical_time
                        THEN (curr_time, (SELECT setval(''SiteHybridLogicalTime'', 1)))::hlc
                        ELSE ((T.pts).physical_time, (SELECT nextval(''SiteHybridLogicalTime'')))::hlc END)::vclock_and_hlc
                    FROM T
                );
            END;
            $D$ LANGUAGE PLPGSQL;
            ', array_to_string(next_lts, ', ')
        );

        SELECT array_agg(format(
            'lts[%1$s] = maxes.m[%1$s]', site_id)
            ORDER BY site_id
        ) INTO match_lts
        FROM ClusterInfo;

        EXECUTE format(
            'CREATE OR REPLACE VIEW DataAll AS
                SELECT id, key, type, data, site, lts, pts, op, ctid
                FROM (
                    WITH potential_max AS (
                        WITH maxes AS (
                            SELECT id, key, (
                                SELECT array [%s]
                                FROM LocalAndShared
                                WHERE id = t_.id AND key = t_.key
                            ) m
                            FROM (
                                SELECT DISTINCT id, key
                                FROM LocalAndShared
                            ) t_
                        )
                        SELECT maxes.id, maxes.key, type, data, site, lts, pts, op, ctid
                        FROM LocalAndShared, maxes
                        WHERE LocalAndShared.id = maxes.id AND LocalAndShared.key = maxes.key
                            AND (%s)
                    )
                    SELECT t1.*, NOT vclock_lte(t1.lts, t2.lts) OR t1.lts = t2.lts lte
                    FROM potential_max t1
                    JOIN LocalAndShared t2 ON t1.id = t2.id AND t1.key = t2.key
                ) t
                GROUP BY id, key, type, data, site, lts, pts, op, ctid
                HAVING bool_and(lte) = true;
        ', array_to_string(max_lts, ', '), array_to_string(match_lts, ' OR '));

        SELECT count(*) INTO n_sites
        FROM ClusterInfo;

        EXECUTE format('CREATE INDEX ON Local ((lts[%s]));', n_sites);

        RETURN true;
    END
$$ LANGUAGE PLPGSQL;


-- Computes the next next timestamp, or a zeroed clock if it is the first one
-- (when new sites are added, this function will be replaced by another which considers the extra ones)
CREATE OR REPLACE FUNCTION nextTimestamp(id_ varchar) RETURNS vclock_and_hlc AS $$
BEGIN
    RETURN (
        WITH T AS (
            SELECT array [coalesce(max(lts[1]), 0) + 1] as lts,
                coalesce((SELECT (last_value, 0)::hlc FROM WallClockSeq), (0, 0)::hlc) as pts,
                round(extract(epoch FROM clock_timestamp()) * 1000) as curr_time
            FROM AllRows
            WHERE id = id_
        )
        SELECT (lts,
            CASE WHEN curr_time > (T.pts).physical_time
            THEN (curr_time, (SELECT setval('SiteHybridLogicalTime', 1)))::hlc
            ELSE ((T.pts).physical_time, (SELECT nextval('SiteHybridLogicalTime')))::hlc END)::vclock_and_hlc
        FROM T
    );
END;
$$ LANGUAGE PLPGSQL;


-- Adds a trigger to ensure the referential integrity of some structure. This is used for nested
-- structures when we want to ensure that when we add a value to an inner structure, the outer
-- element remains even with concurrent removes. E.g., map of sets where we add to some set in that
-- map but concurrently remove the respective kv entry. In this case, the kv entry can be forced to
-- stay if we also perform an add to the map in the same transaction.
-- This function adds the trigger in all sites of the cluster.
-- src represents the identifiers of the source element (id and key for maps, or id for sets);
-- dst represents the identifier of the destination structure (id);
-- addFunc is the name of the function to add the src element.
CREATE OR REPLACE FUNCTION add_referential_integrity(src varchar[], dst varchar, addFunc varchar) RETURNS void AS $$
    BEGIN
        EXECUTE format('
            CREATE OR REPLACE FUNCTION referential_integrity_%s_%s_f() RETURNS TRIGGER AS $d$
            BEGIN
                PERFORM %s(%s, ''%s'');
                RETURN new;
            END;
            $d$ LANGUAGE PLPGSQL;',
            array_to_string(src, '_'), dst, addFunc, (SELECT string_agg(quote_literal(x), ',') FROM unnest(src) AS x), dst
        );

        EXECUTE format('
            CREATE OR REPLACE TRIGGER referential_integrity_%s_%s
            AFTER INSERT ON SHARED
            FOR EACH ROW
            WHEN (new.id = ''%s'')
            EXECUTE FUNCTION referential_integrity_%s_%s_f()',
            array_to_string(src, '_'), dst, dst, array_to_string(src, '_'), dst
        );
    END;
$$ LANGUAGE PLPGSQL;


-- Removes a referential integrity trigger.
-- This function removes the trigger in all sites of the cluster.
-- src represents the identifiers of the source element (id and key for maps, or id for sets);
-- dst represents the identifier of the destination structure (id);
CREATE OR REPLACE FUNCTION rmv_referential_integrity(src varchar[], dst varchar) RETURNS void AS $$
    BEGIN
        EXECUTE format(
            'DROP FUNCTION referential_integrity_%s_%s_f CASCADE', array_to_string(src, '_'), dst
        );
    END;
$$ LANGUAGE PLPGSQL;


-- Uses Postgres' advisory lock function to lock an item. Alternative version to the one above.
-- Since no table is updated, it should in theory be slightly faster.
-- Used to avoid conflicts in the merge procedure.
CREATE OR REPLACE FUNCTION _access_elem(id_ varchar) RETURNS void AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(id_, 0));
END;
$$ LANGUAGE PLPGSQL;

-- Deletes operations in the causal past of the respective CRDT
-- (used by the merge function)
CREATE OR REPLACE FUNCTION _delete_past_ops(id_ varchar, key_ varchar, lts_ vclock) RETURNS void AS $$
BEGIN
    DELETE
    FROM Local
    WHERE id = id_
        AND key = key_
        AND vclock_lte(lts, lts_)
        AND lts <> lts_;
END;
$$ LANGUAGE PLPGSQL;


-- computes whether this operation is already obsolete in the context of the CRDT;
-- (used by the merge function)
CREATE OR REPLACE FUNCTION _is_operation_obsolete(id_ varchar, key_ varchar, lts_ vclock) RETURNS boolean AS $$
BEGIN
    -- check if this operation was replaced by a future operation
    RETURN count(*) > 0
    FROM Local
    WHERE id = id_
        AND key = key_
        AND vclock_lte(lts_, lts)
        AND lts_ <> lts;
END;
$$ LANGUAGE PLPGSQL;


-- Merges a new operation with the existing data
CREATE OR REPLACE FUNCTION merge(id_ varchar, key_ varchar, type_ "char", data_ varchar, site_ int, lts_ vclock, pts_ hlc, op_ "char")
RETURNS void AS $$
    BEGIN
        -- acquire a lock to the element
        -- (to avoid conflicts, e.g., deadlocks when deleting past versions)
        PERFORM _access_elem(id_ || '.' || key_);

        -- find if this operation was already applied or if it is an obsolete operation
        IF _is_operation_obsolete(id_, key_, lts_) THEN
            RETURN;
        END IF;

        -- remove obsolete entries
        -- i.e., operations on the same element in the causal past
        PERFORM _delete_past_ops(id_, key_, lts_);

        INSERT INTO Local
        VALUES (id_, key_, type_, data_, site_, lts_, pts_, op_);

        -- update the wall clock
        PERFORM setval('WallClockSeq', greatest((pts_).physical_time, (SELECT last_value FROM WallClockSeq)) , true);
    END
$$ LANGUAGE PLPGSQL;


-- Adds the operation into the Shared table
CREATE OR REPLACE FUNCTION handleOp(id_ varchar, key_ varchar, type_ "char", data_ varchar, site_ int, lts_ vclock, pts_ hlc, op_ "char") RETURNS void AS $$
    BEGIN
        INSERT INTO Shared VALUES (id_, key_, type_, data_, site_, lts_, pts_, op_, default);
    END;
$$ LANGUAGE PLPGSQL;


-- Merges a batch of a partition of the Shared table.
CREATE OR REPLACE FUNCTION merge_batch(batch xid[]) RETURNS bool AS $$
BEGIN
    PERFORM merge(id, key, type, data, site, lts, pts, op)
    FROM Shared
    WHERE xmin IN (
        SELECT unnest(batch)
    )
    ORDER BY id, key;

    DELETE
    FROM Shared
    WHERE xmin = ANY(batch);

    RETURN true;
END
$$ LANGUAGE PLPGSQL;


-- Continuously merges batches of a partition until the entire partition has been merged.
-- Partitions are computed by hashing the key and performing the modulo function over 'num_partitions'.
-- Each partition is divided into batches of at most 'max_batch_size' rows. Batching is done to
-- separate merges into multiple transactions, reducing the amount of time each lock is held.
CREATE OR REPLACE PROCEDURE merge_partition(partition integer, num_partitions integer, max_batch_size integer) AS $$
DECLARE
    batches xid[][];
    i integer;
    j integer;
BEGIN
    -- build an array with the transaction id of all rows in this partition
    SELECT array_agg(xmin ORDER BY xmin::text::bigint DESC) INTO batches
    FROM Shared
    -- ensures that all data from the same transaction ends up in the same partition
    WHERE xmin::text::bigint % num_partitions = partition;

    i := 1;
    WHILE i <= array_length(batches, 1) LOOP
        j := i + max_batch_size;
        -- ensure that all data from the same transaction is merged in the same transaction
        WHILE j <= array_length(batches, 1) AND batches[j] = batches[j - 1] LOOP
            j := j + 1;
        END LOOP;

        PERFORM merge_batch(batches[i:j-1]);

        i := j;
    END LOOP;
END
$$ LANGUAGE PLPGSQL;


-- Manually merges all operations in the Shared table
CREATE OR REPLACE FUNCTION merge() RETURNS void AS $$
BEGIN
    -- in this version, we only need to call merge when using the sync mode
    IF EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'shared_insert_local_sync_trigger'
          AND tgenabled = 'D'
    ) THEN
        CALL merge_partition(0, 1, 1000);
    ELSE
        DELETE
        FROM Shared;
    END IF;
END;
$$ LANGUAGE PLPGSQL;


-- Switches the read mode to 'local' or 'all'.
-- local - considers only the data on the local table
-- all - considers the data in the local and shared tables
CREATE OR REPLACE FUNCTION switch_read_mode(mode varchar) RETURNS void AS $$
    BEGIN
        IF mode = 'local' THEN
            CREATE OR REPLACE VIEW Data AS
            SELECT *
            FROM DataLocal;

            CREATE OR REPLACE VIEW AllRows AS
            SELECT *
            FROM DataLocal;

            ALTER TABLE Shared DISABLE TRIGGER Shared_wall_clock_trigger;

            FOR i in 1..(SELECT count(*) FROM ClusterInfo) LOOP
                EXECUTE format('DROP INDEX IF EXISTS Shared_lts_%s;', i);
            END LOOP;
        ELSEIF mode = 'all' THEN
            CREATE OR REPLACE VIEW Data AS
            SELECT *
            FROM DataAll;

            CREATE OR REPLACE VIEW AllRows AS
            SELECT *
            FROM LocalAndShared;

            ALTER TABLE Shared ENABLE REPLICA TRIGGER Shared_wall_clock_trigger;

            FOR i in 1..(SELECT count(*) FROM ClusterInfo) LOOP
                EXECUTE format('CREATE INDEX IF NOT EXISTS Shared_lts_%s ON Shared ((lts[%s]));', i, i);
            END LOOP;
        ELSE
            RAISE EXCEPTION 'Mode ''%'' does not exist. The supported modes are ''local'' and ''all''.', mode;
        END IF;
    END;
$$ LANGUAGE PLPGSQL;


-- Switches the write mode to 'sync' or 'async'.
-- sync - writes are immediately merged
-- async - writes must be merged manually with the merge() function
CREATE OR REPLACE FUNCTION switch_write_mode(mode varchar) RETURNS void AS $$
    BEGIN
        IF mode = 'sync' THEN
            ALTER TABLE Shared ENABLE TRIGGER Shared_insert_local_sync_trigger;
        ELSEIF mode = 'async' THEN
            ALTER TABLE Shared DISABLE TRIGGER Shared_insert_local_sync_trigger;
        ELSE
            RAISE EXCEPTION 'Mode ''%'' does not exist. The supported modes are ''sync'' and ''async''.', mode;
        END IF;
    END;
$$ LANGUAGE PLPGSQL;

CREATE OR REPLACE FUNCTION set_mode(mode varchar) RETURNS void AS $$
    BEGIN
        IF mode = 'sync' THEN
            PERFORM switch_read_mode('local');
            PERFORM switch_write_mode('sync');
        ELSEIF mode = 'async' THEN
            PERFORM switch_read_mode('all');
            PERFORM switch_write_mode('async');
        ELSE
            RAISE EXCEPTION 'Mode ''%'' does not exist. The supported modes are ''sync'' and ''async''.', mode;
        END IF;
    END;
$$ LANGUAGE PLPGSQL;
`;

const _crdts = [
  // counter
  `
  -- add multiple values
  CREATE OR REPLACE VIEW Counter AS
      SELECT id AS id, sum(data::bigint) AS data
      FROM Data
      WHERE type = 'c'
      GROUP BY id;

  -- Get a counter by id
  CREATE OR REPLACE FUNCTION counterGet(id_ varchar) RETURNS bigint AS $$
  BEGIN
      RETURN data
      FROM Counter
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Increment a delta to a counter
  CREATE OR REPLACE FUNCTION counterInc(id_ varchar, delta_ bigint) RETURNS void AS $$
  BEGIN
      -- unlike other structures, all operations affect the final result, so same-site concurrency
      -- must be avoided
      PERFORM _access_elem(id_);

      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, siteId(), 'c', 
          (SELECT coalesce((SELECT data::bigint FROM Data WHERE id = id_ AND key::integer = siteId()), 0)) + delta_, 
          siteId(), lts, pts, 'a'
      FROM nextTimestamp(id_);
  END;
  $$ LANGUAGE PLPGSQL;

  -- Decrement a delta to a counter
  CREATE OR REPLACE FUNCTION counterDec(id_ varchar, delta_ bigint) RETURNS void AS $$
  BEGIN
      -- unlike other structures, all operations affect the final result, so same-site concurrency
      -- must be avoided
      PERFORM _access_elem(id_);

      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, siteId(), 'c', 
          (SELECT coalesce((SELECT data::bigint FROM Data WHERE id = id_ AND key::integer = siteId()), 0)) - delta_, 
          siteId(), lts, pts, 'a'
      FROM nextTimestamp(id_);
  END;
  $$ LANGUAGE PLPGSQL;
  `,

  // register
  `
  -- mvr
  CREATE OR REPLACE VIEW RegisterMvr AS
      SELECT id AS id, array_agg(data ORDER BY site) AS data
      FROM Data
      WHERE type = 'r'
      GROUP BY id;

  -- lww
  CREATE OR REPLACE VIEW RegisterLww AS
      SELECT id AS id, data
      FROM (
          SELECT id, data,
              rank() OVER (PARTITION BY id ORDER BY pts DESC, site, data, ctid
              ) AS rank
          FROM Data
          WHERE type = 'r'
      ) t
      WHERE rank = 1;

  -- Get a register by id (mvr)
  CREATE OR REPLACE FUNCTION registerMvrGet(id_ varchar) RETURNS varchar[] AS $$
  BEGIN
      RETURN data
      FROM RegisterMvr
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get a register by id (mvr)
  CREATE OR REPLACE FUNCTION registerLwwGet(id_ varchar) RETURNS varchar AS $$
  BEGIN
      RETURN data
      FROM RegisterLww
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;


  -- Set a register value
  CREATE OR REPLACE FUNCTION registerSet(id_ varchar, value_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, '', 'r', value_, siteId(), (t).lts, (t).pts, 'a'
      FROM nextTimestamp(id_) AS t;
  END;
  $$ LANGUAGE PLPGSQL;
  `,

  // set
  `
  -- add wins
  CREATE OR REPLACE VIEW SetAw AS
      SELECT id AS id, key AS data
      FROM (
          SELECT id, key, op, 
              rank() OVER (PARTITION BY id, key ORDER BY lts, site) AS rank
          FROM Data
          WHERE type = 's'
              AND op = 'a'
      ) t 
      WHERE rank = 1;

  -- add wins - entire set in the same tuple
  CREATE OR REPLACE VIEW SetAwTuple AS
      SELECT id, array_agg(data) AS data
      FROM SetAw
      GROUP BY id;

  -- remove wins
  CREATE OR REPLACE VIEW SetRw AS
      SELECT id AS id, key AS data
      FROM (
          SELECT id, key, op, 
              rank() OVER (
                  PARTITION BY id, key 
                  ORDER BY array_position('{r, a}', op), lts, site
              ) AS rank
          FROM Data
          WHERE type = 's'
      ) t 
      WHERE rank = 1
          AND op != 'r';

  -- remove wins - entire set in the same tuple
  CREATE OR REPLACE VIEW SetRwTuple AS
      SELECT id, array_agg(data) AS data
      FROM SetRw
      GROUP BY id;

  -- lww
  CREATE OR REPLACE VIEW SetLww AS
      SELECT id AS id, key AS data
      FROM (
          SELECT id, key, op,
              rank() OVER (
                  PARTITION BY id, key 
                  ORDER BY pts DESC, site, ctid
              ) AS rank
          FROM Data
          WHERE type = 's'
      ) t
      WHERE rank = 1
          AND op != 'r';

  -- lww - entire set in the same tuple
  CREATE OR REPLACE VIEW SetLwwTuple AS
      SELECT id, array_agg(data) AS data
      FROM SetLww
      GROUP BY id;

  -- Get a set by id (add wins)
  CREATE OR REPLACE FUNCTION setAwGet(id_ varchar) RETURNS varchar[] AS $$
  BEGIN
      RETURN data
      FROM SetAwTuple
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get a set by id (remove wins)
  CREATE OR REPLACE FUNCTION setRwGet(id_ varchar) RETURNS varchar[] AS $$
  BEGIN
      RETURN data
      FROM SetRwTuple
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get a set by id (lww)
  CREATE OR REPLACE FUNCTION setLwwGet(id_ varchar) RETURNS varchar[] AS $$
  BEGIN
      RETURN data
      FROM SetLwwTuple
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;


  -- Check if an element is in a set (add wins)
  CREATE OR REPLACE FUNCTION setAwContains(id_ varchar, elem_ varchar) RETURNS bool AS $$
  BEGIN
      RETURN EXISTS (
          SELECT 1
          FROM SetAw
          WHERE id = id_
              AND data = elem_
      );
  END;
  $$ LANGUAGE PLPGSQL;

  -- Check if an element is in a set (remove wins)
  CREATE OR REPLACE FUNCTION setRwContains(id_ varchar, elem_ varchar) RETURNS bool AS $$
  BEGIN
      RETURN EXISTS (
          SELECT 1
          FROM SetRw
          WHERE id = id_
              AND data = elem_
      );
  END;
  $$ LANGUAGE PLPGSQL;

  -- Check if an element is in a set (lww)
  CREATE OR REPLACE FUNCTION setLwwContains(id_ varchar, elem_ varchar) RETURNS bool AS $$
  BEGIN
      RETURN EXISTS (
          SELECT 1
          FROM SetLww
          WHERE id = id_
              AND data = elem_
      );
  END;
  $$ LANGUAGE PLPGSQL;


  -- Add a value to a set
  CREATE OR REPLACE FUNCTION setAdd(id_ varchar, value_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, value_, 's', null, siteId(), (t).lts, (t).pts, 'a'
      FROM nextTimestamp(id_) AS t;
  END;
  $$ LANGUAGE PLPGSQL;


  -- Remove a value from a set
  CREATE OR REPLACE FUNCTION setRmv(id_ varchar, value_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, value_, 's', null, siteId(), (t).lts, (t).pts, 'r'
      FROM nextTimestamp(id_) AS t;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Clear set, i.e., remove all elements
  CREATE OR REPLACE FUNCTION setClear(id_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, data, 's', null, siteId(), (t).lts, (t).pts, 'r'
      FROM SetAw
      JOIN nextTimestamp(id_) AS t ON true
      WHERE id = id_
      ORDER BY id_, data;
  END;
  $$ LANGUAGE PLPGSQL;
  `,

  // map
  `
  -- add wins + mvr for concurrent adds
  CREATE OR REPLACE VIEW MapAwMvr AS
      SELECT id as id, (key, array_agg(data ORDER BY site))::mEntryMvr AS data
      FROM Data
      WHERE type = 'm'
          AND op = 'a'
      GROUP BY id, key;

  -- add wins + mvr for concurrent adds - entire map in the same tuple
  CREATE OR REPLACE VIEW MapAwMvrTuple AS
      SELECT id, array_agg(data) AS data
      FROM MapAwMvr
      GROUP by id;

  -- add wins + lww for concurrent adds
  CREATE OR REPLACE VIEW MapAwLww AS
      SELECT id as id, (key, data)::mEntry AS data
      FROM (
          SELECT id, key, data, op, 
              rank() OVER (
                  PARTITION BY id, key 
                  ORDER BY array_position('{a, r}', op), pts DESC, site, data, ctid
              ) AS rank
          FROM Data
          WHERE type = 'm'
      ) t 
      WHERE rank = 1 
          AND op != 'r';

  -- add wins + lww for concurrent adds - entire map in the same tuple
  CREATE OR REPLACE VIEW MapAwLwwTuple AS
      SELECT id, array_agg(data) AS data
      FROM MapAwLww
      GROUP BY id;

  -- remove wins + mvr
  CREATE OR REPLACE VIEW MapRwMvr AS
      SELECT id as id, (key, array_agg(data ORDER BY site))::mEntryMvr AS data
      FROM (
          SELECT id, key, data, op, site,
              rank() over (
                  PARTITION BY id, key 
                  ORDER BY array_position('{r, a}', op)
              ) AS rank
          FROM Data
          WHERE type = 'm'
      ) t 
      WHERE rank = 1 
          AND op != 'r'
      GROUP BY id, key;

  -- remove wins + lww
  CREATE OR REPLACE VIEW MapRwLww AS
      SELECT id as id, (key, data)::mEntry AS data
      FROM (
          SELECT id, key, data, op, site,
              rank() over (
                  PARTITION BY id, key 
                  ORDER BY array_position('{r, a}', op), pts DESC, site, data, ctid
              ) AS rank
          FROM Data
          WHERE type = 'm'
      ) t 
      WHERE rank = 1 
          AND op != 'r';

  -- remove wins - entire map in the same tuple
  CREATE OR REPLACE VIEW MapRwMvrTuple AS
      SELECT id, array_agg(data) AS data
      FROM MapRwMvr
      GROUP BY id;

  -- lww
  CREATE OR REPLACE VIEW MapLww AS
      SELECT id as id, (key, data)::mEntry AS data
      FROM (
          SELECT id, key, data, op,
              rank() over (
                  PARTITION BY id, key 
                  ORDER BY pts DESC, site, data, ctid
              ) AS rank
          FROM Data
          WHERE type = 'm'
      ) t
      WHERE rank = 1
          AND op != 'r';

  -- lww - entire map in the same tuple
  CREATE OR REPLACE VIEW MapLwwTuple AS
      SELECT id, array_agg(data) AS data
      FROM MapLww
      GROUP BY id;


  -- Get a map by id (add wins + mvr)
  CREATE OR REPLACE FUNCTION mapAwMvrGet(id_ varchar) RETURNS mEntryMvr[] AS $$
  BEGIN
      RETURN data
      FROM MapAwMvrTuple
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get a map by id (add wins + lww)
  CREATE OR REPLACE FUNCTION mapAwLwwGet(id_ varchar) RETURNS mEntry[] AS $$
  BEGIN
      RETURN data
      FROM MapAwLwwTuple
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get a map by id (remove wins)
  CREATE OR REPLACE FUNCTION mapRwMvrGet(id_ varchar) RETURNS mEntryMvr[] AS $$
  BEGIN
      RETURN data
      FROM MapRwMvrTuple
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get a map by id (lww)
  CREATE OR REPLACE FUNCTION mapLwwGet(id_ varchar) RETURNS mEntry[] AS $$
  BEGIN
      RETURN data
      FROM MapLwwTuple
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get the value of a map by key (add wins + mvr)
  CREATE OR REPLACE FUNCTION mapAwMvrValue(id_ varchar, key_ varchar) RETURNS varchar[] AS $$
  BEGIN
      RETURN (data).value
      FROM MapAwMvr
      WHERE id = id_
          AND (data).key = key_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get the value of a map by key (add wins + lww)
  CREATE OR REPLACE FUNCTION mapAwLwwValue(id_ varchar, key_ varchar) RETURNS varchar AS $$
  BEGIN
      RETURN (data).value
      FROM MapAwLww
      WHERE id = id_
          AND (data).key = key_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get the value of a map by key (remove wins)
  CREATE OR REPLACE FUNCTION mapRwMvrValue(id_ varchar, key_ varchar) RETURNS varchar[] AS $$
  BEGIN
      RETURN (data).value
      FROM MapRwMvr
      WHERE id = id_
          AND (data).key = key_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get the value of a map by key (lww)
  CREATE OR REPLACE FUNCTION mapLwwValue(id_ varchar, key_ varchar) RETURNS varchar AS $$
  BEGIN
      RETURN (data).value
      FROM MapLww
      WHERE id = id_
          AND (data).key = key_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Check if a key is in a map (add wins + mvr)
  CREATE OR REPLACE FUNCTION mapAwMvrContains(id_ varchar, key_ varchar) RETURNS bool AS $$
  BEGIN
      RETURN EXISTS (
          SELECT 1
          FROM MapAwMvr
          WHERE id = id_
              AND (data).key = key_
      );
  END;
  $$ LANGUAGE PLPGSQL;

  -- Check if a key is in a map (add wins + lww)
  CREATE OR REPLACE FUNCTION mapAwLwwContains(id_ varchar, key_ varchar) RETURNS bool AS $$
  BEGIN
      RETURN EXISTS (
          SELECT 1
          FROM MapAwLww
          WHERE id = id_
              AND (data).key = key_
      );
  END;
  $$ LANGUAGE PLPGSQL;

  -- Check if a key is in a map (remove wins)
  CREATE OR REPLACE FUNCTION mapRwMvrContains(id_ varchar, key_ varchar) RETURNS bool AS $$
  BEGIN
      RETURN EXISTS (
          SELECT 1
          FROM MapRwMvr
          WHERE id = id_
              AND (data).key = key_
      );
  END;
  $$ LANGUAGE PLPGSQL;

  -- Check if a key is in a map (lww)
  CREATE OR REPLACE FUNCTION mapLwwContains(id_ varchar, key_ varchar) RETURNS bool AS $$
  BEGIN
      RETURN EXISTS (
          SELECT 1
          FROM MapLww
          WHERE id = id_
              AND (data).key = key_
      );
  END;
  $$ LANGUAGE PLPGSQL;

  -- Add an entry to a map
  CREATE OR REPLACE FUNCTION mapAdd(id_ varchar, key_ varchar, value_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, key_, 'm', value_, siteId(), (t).lts, (t).pts, 'a'
      FROM nextTimestamp(id_) AS t;
  END
  $$ LANGUAGE PLPGSQL;

  -- Remove a map entry by key
  CREATE OR REPLACE FUNCTION mapRmv(id_ varchar, key_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, key_, 'm', null, siteId(), (t).lts, (t).pts, 'r'
      FROM nextTimestamp(id_) AS t;
  END
  $$ LANGUAGE PLPGSQL;

  -- Clear a map, i.e., remove all entries
  CREATE OR REPLACE FUNCTION mapClear(id_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, (data).key, 'm', null, siteId(), (t).lts, (t).pts, 'r'
      FROM MapAwMvr
      JOIN nextTimestamp(id_) AS t ON true
      WHERE id = id_
      ORDER BY id_, (data).key;
  END
  $$ LANGUAGE PLPGSQL;
  `,

  // list
  `
  CREATE OR REPLACE VIEW List AS
      SELECT id as id, key as pos, data
      FROM Data
      WHERE type = 'l'
          AND op != 'r'
      ORDER BY id, key, site, pts desc;

  -- unsorted list (to be used by the functions)
  CREATE OR REPLACE VIEW _ListUnsorted AS
      SELECT id as id, key as pos, data
      FROM Data
      WHERE type = 'l'
          AND op != 'r';

  -- entire list in the same tuple
  CREATE OR REPLACE VIEW ListTuple AS
      SELECT id, array_agg(data) AS data
      FROM List
      GROUP BY id;


  -- Get a list by id
  CREATE OR REPLACE FUNCTION listGet(id_ varchar) RETURNS varchar[] AS $$
  BEGIN
      RETURN data
      FROM ListTuple
      WHERE id = id_;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get the element from a list at some index
  CREATE OR REPLACE FUNCTION listGetAt(id_ varchar, index_ int) RETURNS varchar AS $$
  BEGIN
      RETURN data
      FROM List
      WHERE id = id_
      OFFSET index_
      LIMIT 1;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Get the first element in a list
  CREATE OR REPLACE FUNCTION listGetFirst(id_ varchar) RETURNS varchar AS $$
  BEGIN
      RETURN data
      FROM _ListUnsorted
      WHERE id = id_
          AND pos = (
              SELECT min(pos)
              FROM _ListUnsorted
              WHERE id = id_
          );
      END;
  $$ LANGUAGE PLPGSQL;

  -- Get the last element in a list
  CREATE OR REPLACE FUNCTION listGetLast(id_ varchar) RETURNS varchar AS $$
  BEGIN
      RETURN data
      FROM _ListUnsorted
      WHERE id = id_
          AND pos = (
              SELECT max(pos)
              FROM _ListUnsorted
              WHERE id = id_
          );
      END;
  $$ LANGUAGE PLPGSQL;

  -- performs the best in random inserts (default)
  CREATE OR REPLACE FUNCTION _char_between_regular(c1 char, c2 char) RETURNS char AS $$
  BEGIN
      RETURN chr((ascii(c1) + ascii(c2)) / 2);
  END;
  $$ LANGUAGE PLPGSQL;

  -- performs the best for appends
  CREATE OR REPLACE FUNCTION _char_between_appends(c1 char, c2 char) RETURNS char AS $$
  BEGIN
      RETURN chr(ascii(c1) + 1);
  END;
  $$ LANGUAGE PLPGSQL;

  -- performs the best for prepends
  CREATE OR REPLACE FUNCTION _char_between_prepends(c1 char, c2 char) RETURNS char AS $$
  BEGIN
      RETURN chr(ascii(c2) - 1);
  END;
  $$ LANGUAGE PLPGSQL;

  -- generation function used by _generateVirtualIndexBetween
  CREATE OR REPLACE FUNCTION _char_between(c1 char, c2 char) RETURNS char AS $$
  BEGIN
      RETURN _char_between_regular(c1, c2);
  END;
  $$ LANGUAGE PLPGSQL;

  CREATE OR REPLACE FUNCTION switch_list_id_generation(mode varchar) RETURNS void AS $$
  BEGIN
      IF mode NOT IN ('regular', 'appends', 'prepends') THEN
          RAISE EXCEPTION 'Mode ''%'' does not exist. The supported modes are ''regular'', ''appends'', and ''prepends''.', mode;
      END IF;

      EXECUTE format(
          'CREATE OR REPLACE FUNCTION _char_between(c1 char, c2 char) RETURNS char AS $D$
          BEGIN
              RETURN _char_between_%s(c1, c2);
          END;
          $D$ LANGUAGE PLPGSQL;',
      mode);
  END;
  $$ LANGUAGE PLPGSQL;

  -- Generate a new virtual index between two virtual indexes
  -- (e.g., (a, c) -> b, (a, b) -> aP)
  CREATE OR REPLACE FUNCTION _generateVirtualIndexBetween(p1_ varchar, p2_ varchar) RETURNS varchar AS $$
  BEGIN
      -- build the string from the chars
      RETURN string_agg(c, '' ORDER BY r)
      FROM (
          -- get the resulting chars:
          -- if the difference between c1 and c2 is zero or one, the resulting char is c1;
          -- otherwise, the (final) char is dictated by the _char_between function
          SELECT coalesce(nullif(ascii(c2) - ascii(c1), 1), 0) AS diff,
              CASE WHEN ascii(c2) - ascii(c1) <= 1  THEN c1 ELSE _char_between(c1, c2) END AS c,
              -- rolling sum of all previous rows, excluding the current one
              sum(coalesce(nullif(ascii(c2) - ascii(c1), 1), 0)) over (ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
              row_number() over() AS r
          FROM (
              -- add padding (first char for p1, last char for p2) and split each char to rows
              SELECT regexp_split_to_table(rpad(p1, greatest(length(p1), length(p2)) + 1, '!'), '') c1,
                  regexp_split_to_table(rpad(p2, greatest(length(p1), length(p2)) + 1, chr(127)), '') c2
              FROM (
                  SELECT coalesce(p1_, '') as p1, coalesce(p2_, '') as p2
              )
          ) t
      ) t
      -- with this, we keep all chars until the first with diff != 0 or 1
      WHERE sum IS NULL OR sum = 0;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Given a physical index (e.g., 0, 1, 2, ...), return the new virtual index that when inserted
  -- to the list will be placed in the specified physical location
  -- (index_ >= 0)
  CREATE OR REPLACE FUNCTION _physicalToVirtualIndex(id_ varchar, index_ bigint) RETURNS varchar AS $$
  BEGIN
      RETURN (
          WITH T AS (
              SELECT pos
              FROM List
              WHERE id = id_
              OFFSET greatest(index_ - 1, 0)
              LIMIT (CASE WHEN index_ = 0 THEN 1 ELSE 2 END)
          )
          SELECT _generateVirtualIndexBetween(
              -- position before the new insert
              (SELECT (CASE WHEN index_ = 0 THEN '' ELSE pos END) FROM T LIMIT 1),
              -- position after the new insert
              (SELECT pos FROM T OFFSET (CASE WHEN index_ = 0 THEN 0 ELSE 1 END) LIMIT 1)
          ) || siteId() -- append the site id to ensure uniqueness
      );
  END;
  $$ LANGUAGE PLPGSQL;

  -- Return the virtual index to point to the last position of some list
  CREATE OR REPLACE FUNCTION _lastVirtualIndex(id_ varchar) RETURNS varchar AS $$
  BEGIN
      RETURN _generateVirtualIndexBetween(
          -- last position
          (SELECT max(pos) FROM _ListUnsorted WHERE id = id_),
          ''
      ) || siteId(); -- append the site id to ensure uniqueness
  END;
  $$ LANGUAGE PLPGSQL;

  -- Return the virtual index to point to the first position of some list
  CREATE OR REPLACE FUNCTION _firstVirtualIndex(id_ varchar) RETURNS varchar AS $$    
  BEGIN
      RETURN _generateVirtualIndexBetween(
          '',
          -- first position
          (SELECT min(pos) FROM _ListUnsorted WHERE id = id_)
      ) || siteId(); -- append the site id to ensure uniqueness
  END;
  $$ LANGUAGE PLPGSQL;

  -- Add an element to a list at some index
  CREATE OR REPLACE FUNCTION listAdd(id_ varchar, index_ bigint, elem_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, (SELECT _physicalToVirtualIndex(id_, index_)), 'l', elem_, siteId(), (t).lts, (t).pts, 'a'
      FROM nextTimestamp(id_) AS t;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Add an element to the end of some list
  CREATE OR REPLACE FUNCTION listAppend(id_ varchar, elem_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, (SELECT _lastVirtualIndex(id_)), 'l', elem_, siteId(), (t).lts, (t).pts, 'a'
      FROM nextTimestamp(id_) AS t;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Add an element to the beginning of some list
  CREATE OR REPLACE FUNCTION listPrepend(id_ varchar, elem_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, (SELECT _firstVirtualIndex(id_)), 'l', elem_, siteId(), (t).lts, (t).pts, 'a'
      FROM nextTimestamp(id_) AS t;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Remove an element from a list at some index
  CREATE OR REPLACE FUNCTION listRmv(id_ varchar, index_ bigint) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, P.pos, 'l', null, siteId(), (t).lts, (t).pts, 'r'
      FROM nextTimestamp(id_) AS t
      JOIN (
          SELECT pos FROM List WHERE id = id_ OFFSET index_ LIMIT 1
      ) P ON true;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Clear a list, i.e., remove all elements
  CREATE OR REPLACE FUNCTION listClear(id_ varchar) RETURNS void AS $$
  BEGIN
      INSERT INTO Data (id, key, type, data, site, lts, pts, op)
      SELECT id_, pos, 'l', null, siteId(), (t).lts, (t).pts, 'r'
      FROM List
      JOIN nextTimestamp(id_) AS t ON true
      WHERE id = id_
      ORDER BY id_, pos;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Removes and returns the first element in a list
  CREATE OR REPLACE FUNCTION listPopFirst(id_ varchar) RETURNS varchar AS $$
  BEGIN
      WITH select_cte AS (
          SELECT listGetFirst(id_)
      ), insert_cte AS (
          INSERT INTO Data (id, key, type, data, site, lts, pts, op)
          SELECT id_, (SELECT min(pos) FROM _ListUnsorted WHERE id = id_), 'l', null, siteId(), (t).lts, (t).pts, 'r'
          FROM nextTimestamp(id_) AS t
      )
      SELECT *
      FROM select_cte;
  END;
  $$ LANGUAGE PLPGSQL;

  -- Removes and returns the last element in a list
  CREATE OR REPLACE FUNCTION listPopLast(id_ varchar) RETURNS varchar AS $$
  BEGIN
      WITH select_cte AS (
          SELECT listGetLast(id_)
      ), insert_cte AS (
          INSERT INTO Data (id, key, type, data, site, lts, pts, op)
          SELECT id_, (SELECT max(pos) FROM _ListUnsorted WHERE id = id_), 'l', null, siteId(), (t).lts, (t).pts, 'r'
          FROM nextTimestamp(id_) AS t
      )
      SELECT *
      FROM select_cte;
  END;
  $$ LANGUAGE PLPGSQL;
  `,
];

const _drop = `
DROP TABLE IF EXISTS __schema_created;
DROP TRIGGER IF EXISTS shared_insert_trigger ON public.shared;
DROP TRIGGER IF EXISTS shared_wall_clock_trigger ON public.shared;
DROP RULE IF EXISTS data_insert_rule ON public.data;
DROP INDEX IF EXISTS public.shared_idx;
DROP INDEX IF EXISTS public.local_idx;
DROP INDEX IF EXISTS public.local_id_lts_idx;
ALTER TABLE IF EXISTS ONLY public.structurecontrol DROP CONSTRAINT structurecontrol_pkey;
ALTER TABLE IF EXISTS public.shared ALTER COLUMN seq DROP DEFAULT;
DROP SEQUENCE IF EXISTS public.wallclockseq;
DROP TABLE IF EXISTS public.structurecontrol;
DROP SEQUENCE IF EXISTS public.sitehybridlogicaltime;
DROP SEQUENCE IF EXISTS public.shared_seq_seq;
DROP VIEW IF EXISTS public.nested_view cascade;
DROP VIEW IF EXISTS public.setrwtuple cascade;
DROP VIEW IF EXISTS public.setrw cascade;
DROP VIEW IF EXISTS public.setlwwtuple cascade;
DROP VIEW IF EXISTS public.setlww cascade;
DROP VIEW IF EXISTS public.setawtuple cascade;
DROP VIEW IF EXISTS public.setaw cascade;
DROP VIEW IF EXISTS public.registermvr cascade;
DROP VIEW IF EXISTS public.registerlww cascade;
DROP VIEW IF EXISTS public.maprwlww cascade;
DROP VIEW IF EXISTS public.maprwmvrtuple cascade;
DROP VIEW IF EXISTS public.maprwmvr cascade;
DROP VIEW IF EXISTS public.maplwwtuple cascade;
DROP VIEW IF EXISTS public.maplww cascade;
DROP VIEW IF EXISTS public.mapawmvrtuple cascade;
DROP VIEW IF EXISTS public.mapawmvr cascade;
DROP VIEW IF EXISTS public.mapawlwwtuple cascade;
DROP VIEW IF EXISTS public.mapawlww cascade;
DROP VIEW IF EXISTS public.listtuple cascade;
DROP VIEW IF EXISTS public.list cascade;
DROP VIEW IF EXISTS public.counter cascade;
DROP VIEW IF EXISTS public.allrows cascade;
DROP VIEW IF EXISTS public._listunsorted cascade;
DROP VIEW IF EXISTS public.data cascade;
DROP VIEW IF EXISTS public.datalocal cascade;
DROP VIEW IF EXISTS public.dataall cascade;
DROP VIEW IF EXISTS public.localandshared cascade;
DROP TABLE IF EXISTS public.shared;
DROP TABLE IF EXISTS public.local;
DROP FUNCTION IF EXISTS public.set_mode(mode character varying);
DROP FUNCTION IF EXISTS public.switch_write_mode(mode character varying);
DROP FUNCTION IF EXISTS public.switch_read_mode(mode character varying);
DROP FUNCTION IF EXISTS public.switch_list_id_generation(mode character varying);
DROP FUNCTION IF EXISTS public.shared_wall_clock_function();
DROP FUNCTION IF EXISTS public.shared_insert_function();
DROP FUNCTION IF EXISTS public.setrwget(id_ character varying);
DROP FUNCTION IF EXISTS public.setrwcontains(id_ character varying, elem_ character varying);
DROP FUNCTION IF EXISTS public.setrmv(id_ character varying, value_ character varying);
DROP FUNCTION IF EXISTS public.setlwwget(id_ character varying);
DROP FUNCTION IF EXISTS public.setlwwcontains(id_ character varying, elem_ character varying);
DROP FUNCTION IF EXISTS public.setclear(id_ character varying);
DROP FUNCTION IF EXISTS public.setawget(id_ character varying);
DROP FUNCTION IF EXISTS public.setawcontains(id_ character varying, elem_ character varying);
DROP FUNCTION IF EXISTS public.setadd(id_ character varying, value_ character varying);
DROP FUNCTION IF EXISTS public.rmv_referential_integrity(src character varying[], dst character varying);
DROP FUNCTION IF EXISTS public.registerset(id_ character varying, value_ character varying);
DROP FUNCTION IF EXISTS public.registermvrget(id_ character varying);
DROP FUNCTION IF EXISTS public.registerlwwget(id_ character varying);
DROP FUNCTION IF EXISTS public.nsites();
DROP FUNCTION IF EXISTS public.nexttimestamp(id_ character varying);
DROP PROCEDURE IF EXISTS public.merge_partition(IN partition integer, IN num_partitions integer, IN max_batch_size integer);
DROP FUNCTION IF EXISTS public.merge_batch(batch bigint[]);
DROP FUNCTION IF EXISTS public.merge(id_ character varying, key_ character varying, type_ "char", data_ character varying, site_ integer, lts_ public.vclock, pts_ public.hlc, op_ "char");
DROP FUNCTION IF EXISTS public.merge();
DROP FUNCTION IF EXISTS public.maprwmvrvalue(id_ character varying, key_ character varying);
DROP FUNCTION IF EXISTS public.maprwmvrget(id_ character varying);
DROP FUNCTION IF EXISTS public.maprwmvrcontains(id_ character varying, key_ character varying);
DROP FUNCTION IF EXISTS public.maprmv(id_ character varying, key_ character varying);
DROP FUNCTION IF EXISTS public.maplwwvalue(id_ character varying, key_ character varying);
DROP FUNCTION IF EXISTS public.maplwwget(id_ character varying);
DROP FUNCTION IF EXISTS public.maplwwcontains(id_ character varying, key_ character varying);
DROP FUNCTION IF EXISTS public.mapclear(id_ character varying);
DROP FUNCTION IF EXISTS public.mapawmvrvalue(id_ character varying, key_ character varying);
DROP FUNCTION IF EXISTS public.mapawmvrget(id_ character varying);
DROP FUNCTION IF EXISTS public.mapawmvrcontains(id_ character varying, key_ character varying);
DROP FUNCTION IF EXISTS public.mapawlwwvalue(id_ character varying, key_ character varying);
DROP FUNCTION IF EXISTS public.mapawlwwget(id_ character varying);
DROP FUNCTION IF EXISTS public.mapawlwwcontains(id_ character varying, key_ character varying);
DROP FUNCTION IF EXISTS public.mapadd(id_ character varying, key_ character varying, value_ character varying);
DROP FUNCTION IF EXISTS public.listrmv(id_ character varying, index_ bigint);
DROP FUNCTION IF EXISTS public.listprepend(id_ character varying, elem_ character varying);
DROP FUNCTION IF EXISTS public.listpoplast(id_ character varying);
DROP FUNCTION IF EXISTS public.listpopfirst(id_ character varying);
DROP FUNCTION IF EXISTS public.listgetlast(id_ character varying);
DROP FUNCTION IF EXISTS public.listgetfirst(id_ character varying);
DROP FUNCTION IF EXISTS public.listgetat(id_ character varying, index_ integer);
DROP FUNCTION IF EXISTS public.listget(id_ character varying);
DROP FUNCTION IF EXISTS public.listclear(id_ character varying);
DROP FUNCTION IF EXISTS public.listappend(id_ character varying, elem_ character varying);
DROP FUNCTION IF EXISTS public.listadd(id_ character varying, index_ bigint, elem_ character varying);
DROP FUNCTION IF EXISTS public.initsite(site_id_ integer);
DROP FUNCTION IF EXISTS public.initiallogicaltime();
DROP FUNCTION IF EXISTS public.handleop(id_ character varying, key_ character varying, type_ "char", data_ character varying, site_ integer, lts_ public.vclock, pts_ public.hlc, op_ "char");
DROP FUNCTION IF EXISTS public.currenttimemillis();
DROP FUNCTION IF EXISTS public.counterget(id_ character varying);
DROP FUNCTION IF EXISTS public.counterinc(id_ character varying, delta_ bigint);
DROP FUNCTION IF EXISTS public.counterdec(id_ character varying, delta_ bigint);
DROP FUNCTION IF EXISTS public.addremotesite(site_id_ integer);
DROP FUNCTION IF EXISTS public.add_referential_integrity(src character varying[], dst character varying, addfunc character varying);
DROP FUNCTION IF EXISTS public._physicaltovirtualindex(id_ character varying, index_ bigint);
DROP FUNCTION IF EXISTS public._lastvirtualindex(id_ character varying);
DROP FUNCTION IF EXISTS public._is_operation_obsolete(id_ character varying, key_ character varying, lts_ public.vclock);
DROP FUNCTION IF EXISTS public._generatevirtualindexbetween(p1 character varying, p2 character varying);
DROP FUNCTION IF EXISTS public._firstvirtualindex(id_ character varying);
DROP FUNCTION IF EXISTS public._delete_past_ops(id_ character varying, key_ character varying, lts_ public.vclock);
DROP FUNCTION IF EXISTS public._access_elem(id_ character varying);
DROP FUNCTION IF EXISTS vclock_lte;
DROP FUNCTION IF EXISTS vclock_max;
DROP FUNCTION IF EXISTS next_hlc;
DROP TABLE IF EXISTS public.clusterinfo;
DROP FUNCTION IF EXISTS public.siteid();
DROP TYPE IF EXISTS public.vclock_and_hlc CASCADE;
DROP TYPE IF EXISTS public.mentrymvr CASCADE;
DROP TYPE IF EXISTS public.mentry CASCADE;
DROP TYPE IF EXISTS public.hlc CASCADE;
DROP DOMAIN IF EXISTS public.vclock CASCADE;
`;

export const schema = {
  create: _types + _tables + _sequences + _views + _functions + _crdts.join(""),
  drop: _drop,
};
