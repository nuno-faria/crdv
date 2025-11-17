#!/bin/bash
# Deploys two postgres instances, with versions 16 and 15.

PG_VERSIONS=(16 15)
PORTS=(5432 5433)

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y wget ca-certificates gnupg2 lsb-release
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt/ `lsb_release -cs`-pgdg main" >> /etc/apt/sources.list.d/pgdg.list'
sudo apt-get update

for i in $(seq 0 $((${#PG_VERSIONS[*]}-1))); do
    version=${PG_VERSIONS[i]}
    port=${PORTS[i]}

    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-${version}
    sudo sed -i "s/.*port = .*/port = ${port}/" /etc/postgresql/${version}/main/postgresql.conf
    sudo systemctl restart postgresql

    sudo -u postgres psql -p $port -c "alter user postgres with password 'postgres'"
    sudo sed -i '1ihost    all             all             0.0.0.0/0               md5' /etc/postgresql/${version}/main/pg_hba.conf
    sudo sed -i '1ilocal   all             postgres                                trust' /etc/postgresql/${version}/main/pg_hba.conf

    sudo sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/max_connections = 100/max_connections = 2000/" /etc/postgresql/${version}/main/postgresql.conf
    mem=$(( $(free -g | awk '/^Mem:/{print $2}') / 2 ))
    sudo sed -i "s/shared_buffers = .*/shared_buffers = ${mem}GB/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/#work_mem = .*/work_mem = 1GB/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/max_wal_size = .*/max_wal_size = 10GB/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/#max_worker_processes = .*/max_worker_processes = 200/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/#max_replication_slots = .*/max_replication_slots = 200/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/#max_wal_senders = .*/max_wal_senders = 200/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/#max_logical_replication_workers = .*/max_logical_replication_workers = 200/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/#wal_level = .*/wal_level = 'logical'/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/#random_page_cost = .*/random_page_cost = 0.01/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/#jit =.*/jit = off/" /etc/postgresql/${version}/main/postgresql.conf
    sudo sed -i "s/#max_locks_per_transaction =.*/max_locks_per_transaction = 1024/" /etc/postgresql/${version}/main/postgresql.conf

    ((i++))
done

sudo systemctl restart postgresql

if [[ " ${PORTS[*]} " =~ [[:space:]]5432[[:space:]] ]]; then
    PGPASSWORD=postgres createdb -U postgres -p 5432 testdb
    PGPASSWORD=postgres createdb -U postgres -p 5432 testdb_electric
fi

if [[ " ${PORTS[*]} " =~ [[:space:]]5433[[:space:]] ]]; then
    PGPASSWORD=postgres createdb -U postgres -p 5433 testdb
fi
