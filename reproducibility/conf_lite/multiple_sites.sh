# Execution time per run (seconds)
TIME=30
# Seconds to exclude from the beginning of a run
WARMUP=3
# Second to exclude from the end of a run
COOLDOWN=3
# Number of runs per test (each runs for $TIME seconds)
RUNS=1
# Number of clients for the read tests
WORKERS_R=32
# Number of clients for the write tests
WORKERS_W=1024
# Number of structures
STRUCTURES=100000
# List with benchmark types (r - reads; w - writes)
TYPES=(r w)
# List with engines to test
ENGINES="crdv riak"
# Number of sites to test (1..$MAX_SITES)
MAX_SITES=6
