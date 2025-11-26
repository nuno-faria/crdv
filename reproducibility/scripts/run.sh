#!/bin/bash

export DOCKER_DEFAULT_PLATFORM=linux/amd64
NETWORK="custom-network"
EXTRA_CONTAINER_OPTS=""
# if "true", creates containers that use just a single dedicated core, using Docker's --cpuset-cpus.
# this improves performance when trying to simulate multiple sites in a single machine.
# (available for the engines used in the multiple_sites test, i.e., crdv and riak)
DEDICATE_SINGLE_CORE="false"

# waits until a container is in a healthy state
# $1 - container name
wait_until_healthy() {
    while [[ "$(docker inspect -f {{.State.Health.Status}} $1)" != "healthy" ]]; do
        sleep 1
    done;
}


# drops the benchmarks container
drop_benchmarks() {
    docker rm --force benchmarks &> /dev/null
}


# updates the benchmarks configuration files
# $1 - number of sites for crdv and riak (1 when not provided)
update_benchmarks_configs() {
    local sites=${1:-1}
    local i
    local connections

    connections="--crdv"
    for ((i = 1; i <= sites; i++)); do
        connections="$connections crdv-$i"
    done

    connections="$connections --riak "
    for ((i = 1; i <= sites; i++)); do
        connections="$connections riak-$i"
    done

    connections="$connections --native native --pg_crdt pg_crdt --electric electric"

    docker exec -i benchmarks bash <<EOF
        cd ../deploy
        python3 update_connections.py connections.yaml $connections > /dev/null
        python3 update_configs.py connections.yaml > /dev/null
EOF
}


# creates the container with the benchmarks. drops the previous one, if exists
# also updates the connections information, based on the number of sites provided
# $1 - number of sites for crdv and riak (1 when not provided)
create_benchmarks() {
    cd ..
    docker start benchmarks &> /dev/null || docker run --name benchmarks \
        -v ./results:/main/benchmarks/results --network $NETWORK \
        -dit benchmarks > /dev/null
    cd scripts
    update_benchmarks_configs ${1:-1}
}


# updates a benchmark script with the provided configuration
# $1 - benchmark script
# $2 - configuration file
apply_config() {
    if [[ -z "$1" || -z "$2" ]]; then
        return
    fi

    while read line; do
        if [[ $line != "" && $line != \#* ]]; then
            option=$(echo "$line" | cut -d '=' -f 1)
            docker exec benchmarks sed -i "s/$option=.*/$line/" $1
        fi
    done <$2
}


# drops the crdv cluster
drop_crdv() {
    docker rm --force $(docker ps --filter name="crdv-.+" -aq) &> /dev/null
}


# creates a new crdv cluster. drops the previous cluster, if exists
# $1 - number of sites (1 when not provided)
# $2 - "ring" to deploy with a ring architecture
create_crdv() {
    local sites=${1:-1}
    local i

    drop_crdv

    for ((i = 1; i <= sites; i++)); do
        cpuset=""
        if [ "$DEDICATE_SINGLE_CORE" = "true" ]; then
            cpuset="--cpuset-cpus=$((i - 1))"
        fi
        # --cap-add NET_ADMIN to allow network partitions
        docker run --name crdv-$i --shm-size=1g --network $NETWORK --cap-add NET_ADMIN -dit $cpuset $EXTRA_CONTAINER_OPTS crdv > /dev/null
    done

    for ((i = 1; i <= sites; i++)); do
        wait_until_healthy crdv-$i
    done

    ips="crdv-{1..$sites}"
    docker exec -i crdv-1 bash <<EOF
        cd deploy
        python3 update_connections.py connections.yaml --all $ips > /dev/null
        python3 update_configs.py connections.yaml > /dev/null
        cd ../schema
        python3 createCluster.py cluster.yaml $2 > /dev/null
EOF
}


# drops the native container
drop_native() {
    docker rm --force native &> /dev/null
}


# creates the native container. drops the existing one, if exists.
# the native container simply reuses the crdv image
create_native() {
    drop_native
    docker run --name native --shm-size=1g --network $NETWORK -dit $EXTRA_CONTAINER_OPTS crdv > /dev/null
    wait_until_healthy native
    docker exec native psql -U postgres -d testdb -f schema/sql/05-crdts/02-functions/list.sql > /dev/null
}


# drops the pg_crdt container
drop_pg_crdt() {
    docker rm --force pg_crdt &> /dev/null
}


# creates the pg_crdt container. drops the existing one, if exists.
create_pg_crdt() {
    drop_pg_crdt
    # --cap-add NET_ADMIN to allow network partitions
    docker run --name pg_crdt --shm-size=1g --network $NETWORK --cap-add NET_ADMIN -dit $EXTRA_CONTAINER_OPTS pg_crdt > /dev/null
    wait_until_healthy pg_crdt
}


# drops the electric container
drop_electric() {
    docker rm --force electric &> /dev/null
}


# creates the electric container and starts the electric service. drops the existing one, if exists.
create_electric() {
    drop_electric
    docker run --name electric --shm-size=1g --network $NETWORK -dit electric $EXTRA_CONTAINER_OPTS > /dev/null
    wait_until_healthy electric
    docker exec electric ./run.sh > /dev/null
    # stops the service since it consumes a large amount of memory in the operations test, which can
    # lead to oom. since there are no local-first clients, the service is not required, and the
    # results remain unaffected
    docker exec electric ./components/electric/_build/prod/rel/electric/bin/electric stop > /dev/null 2>&1
}


# drops the riak cluster
drop_riak() {
    docker rm --force $(docker ps --filter name="riak-.+" -aq) &> /dev/null
}


# creates the riak cluster. drops the existing one, if exists.
# $1 - number of sites (1 when not provided)
# $2 - "ring" to deploy with the ring architecture
create_riak() {
    local sites=${1:-1}
    local i

    drop_riak

    for ((i = 1; i <= sites; i++)); do
        cpuset=""
        if [ "$DEDICATE_SINGLE_CORE" = "true" ]; then
            cpuset="--cpuset-cpus=$((i - 1))"
        fi
        # --cap-add NET_ADMIN to allow network partitions
        docker run --name riak-$i --shm-size=1g --network $NETWORK --cap-add NET_ADMIN -dit $cpuset $EXTRA_CONTAINER_OPTS riak > /dev/null
    done

    for ((i = 1; i <= sites; i++)); do
        wait_until_healthy riak-$i
        docker exec riak-$i ./repl-prepare.sh C$i > /dev/null
    done

    for ((i = 1; i <= sites; i++)); do
        if [[ $2 == "ring" ]]; then
            next=$((i%sites + 1))
            docker exec riak-$i ./repl-connect.sh C$next riak-$next > /dev/null
        else
            for ((j = 1; j <= sites; j++)); do
                if [[ "$i" != "$j" ]]; then
                    docker exec riak-$i ./repl-connect.sh C$j riak-$j > /dev/null
                fi
            done
        fi
    done
}


# removes all containers
cleanup() {
    drop_benchmarks
    drop_crdv
    drop_native
    drop_pg_crdt
    drop_electric
    drop_riak
}


# runs a specific benchmark test script
# $1 - benchmark script
# $2 - configuration
# $3 - number of sites (for crdv and riak)
# $4 - extra arguments
run_test() {
    create_benchmarks $3
    apply_config $1 $2
    docker exec -t benchmarks ./$1 $4 |& sed 's/^/  > /'
}


# runs the timestamp encoding tests
timestamp_encoding() {
    echo "Running timestamp encoding"
    create_crdv
    run_test run_timestamp_encoding.sh ../conf/timestamp_encoding.sh 1
    cleanup
}


# runs the materialization strategy tests
materialization_strategy() {
    echo "Running materialization strategy"
    create_crdv
    run_test run_micro_rw.sh ../conf/materialization_strategy.sh 1
    cleanup
}


# runs the plan optimization tests
plan_optimization() {
    echo "Running plan optimization"
    create_crdv
    run_test run_plan_optimization.py "" 1 "-H crdv-1"
}


# runs the nested structures tests
nested_structures() {
    echo "Running nested structures"
    create_crdv
    run_test run_nested.sh ../conf/nested_structures.sh 1
    cleanup
}


# runs the operations tests; runs one engine at a time due to memory constraints
operations() {
    echo "Running operations"
    local engines=$(grep -Po '(?<=ENGINES=).*'  ../conf/operations.sh)

    if [[ $engines == *"crdv"* ]]; then
        create_crdv
        run_test run_micro.sh ../conf/operations.sh 1 crdv
        cleanup
    fi

    if [[ $engines == *"native"* ]]; then
        create_native
        run_test run_micro.sh ../conf/operations.sh 1 native
        cleanup
    fi

    if [[ $engines == *"pg_crdt"* ]]; then
        create_pg_crdt
        run_test run_micro.sh ../conf/operations.sh 1 pg_crdt
        cleanup
    fi

    if [[ $engines == *"electric"* ]]; then
        create_electric
        run_test run_micro.sh ../conf/operations.sh 1 electric
        cleanup
    fi

    if [[ $engines == *"riak"* ]]; then
        create_riak
        run_test run_micro.sh ../conf/operations.sh 1 riak
        cleanup
    fi
}


# runs the concurrency tests
concurrency() {
    echo "Running concurrency"
    create_crdv; create_native; create_pg_crdt; create_electric; create_riak
    run_test run_micro_concurrency.sh ../conf/concurrency.sh 1
    cleanup
}


# runs the storage structures tests
storage_structures() {
    echo "Running storage"
    create_crdv; create_native; create_pg_crdt; create_electric; create_riak
    run_test run_micro_storage.sh ../conf/storage_structures.sh 1
    cleanup
}


# run the storage per site tests
storage_sites() {
    echo "Running storage sites"
    local max_sites=$(grep -Po '(?<=MAX_SITES=).*'  ../conf/storage_sites.sh)
    local engines=$(grep -Po '(?<=ENGINES=).*'  ../conf/storage_sites.sh)

    if [[ $engines == *"crdv"* ]]; then
        local i
        for ((i = 1; i <= max_sites; i++)); do
            create_crdv $i
            run_test run_micro_storage_sites.sh ../conf/storage_sites.sh $i crdv
        done
        cleanup
    fi

    if [[ $engines == *"native"* ]]; then
        create_native
        run_test run_micro_storage_sites.sh ../conf/storage_sites.sh 1 native
        cleanup
    fi

    if [[ $engines == *"electric"* ]]; then
        create_electric
        run_test run_micro_storage_sites.sh ../conf/storage_sites.sh 1 electric
        cleanup
    fi

    if [[ $engines == *"riak"* ]]; then
        create_riak $max_sites
        run_test run_micro_storage_sites.sh ../conf/storage_sites.sh $max_sites riak
        cleanup
    fi
}


# runs the network tests
network() {
    echo "Running network"
    create_crdv 2; create_pg_crdt; create_riak 2
    run_test run_micro_network.sh ../conf/network.sh 2
    cleanup
}

# runs the freshness tests
freshness() {
    echo "Running freshness"
    create_crdv 3; create_pg_crdt; create_riak 3
    run_test run_delay.sh ../conf/freshness.sh 3
    cleanup
}

# runs the multiple sites tests
multiple_sites() {
    echo "Running multiple sites"
    local max_sites=$(grep -Po '(?<=MAX_SITES=).*'  ../conf/multiple_sites.sh)
    local i

    DEDICATE_SINGLE_CORE="true"

    for ((i = 1; i <= max_sites; i++)); do
        create_crdv $i; create_riak $i
        run_test run_micro_scale.sh ../conf/multiple_sites.sh $i
    done

    for ((i = 1; i <= max_sites; i++)); do
        create_crdv $i ring; create_riak $i ring
        run_test run_micro_scale.sh ../conf/multiple_sites.sh $i ring
    done

    DEDICATE_SINGLE_CORE="false"
    cleanup
}


# runs all tests
all() {
    timestamp_encoding
    materialization_strategy
    plan_optimization
    nested_structures
    operations
    concurrency
    storage_structures
    storage_sites
    network
    freshness
    multiple_sites
}


# builds the plots and the document
render() {
    cd ..
    docker run --rm -i \
        -v ./results:/main/reproducibility/results \
        -v ./conf:/main/reproducibility/conf \
        -v ./document:/main/reproducibility/document \
        render
    cd scripts
}


# builds the images and creates the network
setup() {
    cd ../../
    echo "Setting up"
    echo "  Building images"
    docker build . -t benchmarks -f reproducibility/containers/Dockerfile.benchmarks -q > /dev/null &
    docker build . -t crdv -f reproducibility/containers/Dockerfile.crdv -q > /dev/null &
    docker build . -t pg_crdt -f reproducibility/containers/Dockerfile.pg_crdt -q > /dev/null &
    docker build . -t electric -f reproducibility/containers/Dockerfile.electric -q > /dev/null &
    docker build . -t riak -f reproducibility/containers/Dockerfile.riak -q > /dev/null &
    docker build . -t render -f reproducibility/containers/Dockerfile.render -q > /dev/null &
    wait
    echo "  Creating the network"
    docker network inspect $NETWORK > /dev/null 2>&1 || docker network create $NETWORK > /dev/null
    cd reproducibility/scripts
    cleanup
    echo "Setup complete"
}


setup

if [[ -z "$1" ]]; then
    echo "No argument provided, nothing to run."
    exit 0
else
    $1
    render
fi
