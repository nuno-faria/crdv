#!/bin/bash

# CRDV and Riak clusters must be already deployed with the required number of sites. The number of
# sites in use is returned in the benchmark results. To test with nSites=[1, 2, 3], we must deploy
# the cluster three separate times, with 1 site, 2 sites, and 3 sites.

# database(s) should already exist (see schema/create_cluster.sh)
CONFIG="conf/micro_crdv.yaml"
CONFIG_RIAK="conf/micro_riak.yaml"
TIME=60
WARMUP=3
COOLDOWN=3
RUNS=3
WORKERS_R=1024
WORKERS_W=1024
WORKERS=""
STRUCTURES=1000000
TYPES=(r w) # rw - reads and writes; r - only reads; w - only writes
ENGINES="crdv riak"

if [[ "$1" == "ring" ]]; then
    RING=true
else
    RING=false
fi

updateConfig() {
    sed -i'' "s/time:.*/time: $TIME/" backup.yaml
    sed -i'' "s/warmup:.*/warmup: $WARMUP/" backup.yaml
    sed -i'' "s/cooldown:.*/cooldown: $COOLDOWN/" backup.yaml
    sed -i'' "s/runs:.*/runs: $RUNS/" backup.yaml
    sed -i'' "s/workers:.*/workers: [$WORKERS]/" backup.yaml
    sed -i'' "s/itemsPerStructure:.*/itemsPerStructure: $STRUCTURES/" backup.yaml
    sed -i'' "s/initialOpsPerStructure:.*/initialOpsPerStructure: 1/" backup.yaml
    sed -i'' 's/typesToPopulate:.*/typesToPopulate: [register]/' backup.yaml
    sed -i'' 's/discardUnmergedWhenFinished:.*/discardUnmergedWhenFinished: true/' backup.yaml
    sed -i'' "s/mergeDelta:.*/mergeDelta: 0.05/" backup.yaml
    sed -i'' "s/mergeBatchSize:.*/mergeBatchSize: 1000/" backup.yaml
    sed -i'' "s/mergeParallelism:.*/mergeParallelism: 1/" backup.yaml
    sed -i'' 's/weight:.*/weight: 0/' backup.yaml
    if [[ "$1" == "rw" ]]; then
        awk 'replace {sub("weight: 0", "weight: 1", $0)} {print} {replace=/registerGet\s*$/}' backup.yaml > backup.yaml.tmp
        awk 'replace {sub("weight: 0", "weight: 1", $0)} {print} {replace=/registerSet\s*$/}' backup.yaml.tmp > backup.yaml
    elif [[ "$1" == "r" ]]; then
        awk 'replace {sub("weight: 0", "weight: 1", $0)} {print} {replace=/registerGet\s*$/}' backup.yaml > backup.yaml.tmp
        mv backup.yaml.tmp backup.yaml
    else
        awk 'replace {sub("weight: 0", "weight: 1", $0)} {print} {replace=/registerSet\s*$/}' backup.yaml > backup.yaml.tmp
        mv backup.yaml.tmp backup.yaml
    fi
}

run() {
    for type in "${TYPES[@]}"; do
        # the topology does not affect reads
        if [[ "$type" = "r" && "$RING" == true ]]; then
            continue
        fi

        if [[ "$type" = "r" ]]; then
            WORKERS=$WORKERS_R
        else
            WORKERS=$WORKERS_W
        fi

        echo "Running $1 type=$type ring=$RING"
        updateConfig $type
        ./benchmarks --conf backup.yaml --no-log > out.txt
        sites=$(grep -Po '(?<=sites: )\d+' out.txt)
        sed -i'' "s/registerGet,/read,/g" out.txt
        sed -i'' "s/registerSet/write/g" out.txt
        if [[ "$RING" == true ]]; then
            sed -i'' "s/,crdv-sync,/,crdv-sync-ring,/g" out.txt
            sed -i'' "s/,crdv-async,/,crdv-async-ring,/g" out.txt
            sed -i'' "s/,riak,/,riak-ring,/g" out.txt
            SUFFIX="_ring"
        else
            SUFFIX=""
        fi
        grep -Po "(?<=CsvOps:).*" out.txt > results/micro_scale/${1}_${sites}${SUFFIX}_${type}.csv
    done
}

# build
go build > /dev/null

# create the required directories
mkdir -p results/micro_scale

# crdv
if [[ $ENGINES == *"crdv"* ]]; then
    cp $CONFIG backup.yaml
    # sync
    sed -i'' "s/modes:.*/modes: {readMode: local, writeMode: sync}/" backup.yaml
    run sync
    # async
    sed -i'' "s/modes:.*/modes: {readMode: all, writeMode: async}/" backup.yaml
    run async
fi

# riak
if [[ $ENGINES == *"riak"* ]]; then
    cp $CONFIG_RIAK backup.yaml
    run riak
fi

# delete the config backup
rm backup.yaml*

# plot
for type in "${TYPES[@]}"; do
    python3 plot_line.py results/micro_scale/*_$type.csv -x "sites" -y "tps / 1000" -g "engine"  \
        -f "operation == 'total'" -xname "Sites" -yname "Throughput (×1000 tx/s)" -t \
        -colors "#034078" "#1282A2" "#D85343" "#034078" "#1282A2" "#D85343" -markers "X" "o" "^" "X" "o" "^" \
        -gorder crdv-sync crdv-async riak crdv-sync-ring crdv-async-ring riak-ring \
        -dashes '(10000, 1)' '(10000, 1)' '(10000, 1)' '(1, 1)' '(1, 1)' '(1, 1)' \
        -height 3 -width 3 -o results/micro_scale/tps_$type.png

    python3 plot_line.py results/micro_scale/*_$type.csv -x "sites" -y "rt * 1000" -g "engine"  \
        -f "operation == 'total'" -xname "Sites" -yname "Response time (ms)" -t \
        -colors "#034078" "#1282A2" "#D85343" "#034078" "#1282A2" "#D85343" -markers "X" "o" "^" "X" "o" "^" \
        -gorder crdv-sync crdv-async riak crdv-sync-ring crdv-async-ring riak-ring \
        -dashes '(10000, 1)' '(10000, 1)' '(10000, 1)' '(1, 1)' '(1, 1)' '(1, 1)' \
        -height 3 -width 3 -o results/micro_scale/rt_$type.png
done
