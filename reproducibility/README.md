# Reproducibility

## Requirements

- Linux[^1] (Recommended) / MacOS / Windows **instance** with internet connection
  - Minimum recommended specs: 8 vCPUs (x64 recommended), 16 GB RAM, 100 GB NVMe SSD
  - **IMPORTANT**: We recommend using an x64 machine instead of ARM, as we found that deploying Riak clusters with many nodes under MacOS ARM was triggering `segmentation fault` errors in the QEMU virtualization layer.
- **Docker**
  - To install in Windows: https://docs.docker.com/desktop/install/windows-install/
  - To install in MacOS: https://docs.docker.com/desktop/install/mac-install/
  - To install in Linux: https://docs.docker.com/engine/install/
    - The following command can also be used in some Linux distributions (Ubuntu/Debian/RHEL/Fedora, with RHEL/Fedora requiring an additional `sudo service docker start`):
      ```shell
      curl -fsSL https://get.docker.com | sh
      ```
- This repository:
  ```shell
  git clone https://github.com/nuno-faria/crdv
  cd crdv/reproducibility
  ```

[^1]: Successfully tested with the following Linux distributions:
  Ubuntu (24.04) | Debian (12.6) | RHEL (9.4) | Fedora (40) | SUSE (15.6) | Amazon Linux (2023) | Arch

## Run

Assumes `reproducibility` as the current working directory. 
`sudo` must be provided in the Unix systems if `docker` needs to run as root.
To run smaller/faster tests, see the [Configuration](#configuration) section.

### Run everything

*Estimated runtime: **25 hours** with the default configuration or **8 hours** with the [lite configuration](#lite-tests).*

- Linux/MacOS/Windows WSL
```shell
chmod +x run_unix.sh
./run_unix.sh
```

- Windows (Powershell)
```shell
./run_windows.ps1
```

This will run all tests in the paper. The raw results will be available at `results`. A PDF document compiling all plots is also provided at `document/main.pdf`.

### Run specific tests

To run a specific test, we can pass it as an argument to the respective run script:

```shell
# unix
./run_unix.sh [test1 test2 ...] [cleanup]

# windows
./run_windows.ps1 [test1 test2 ...] [cleanup]
```

Example:
```shell
# runs the "timestamp_encoding" and "nested" tests;
# also deletes the main container and image
./run_unix.sh timestamp_encoding nested cleanup
```

The script creates the main image and container to execute the tests, if they do not exist.
The `cleanup` flag deletes the main container and image, so it should be used when we do not need to execute any more tests.

List of available tests:

| Test name | Label | Caption |
|---|---|---|
| `timestamp_encoding` | Figure&nbsp;6 | *Comparison of different timestamp encodings.* |
| `materialization_strategy` | Figure&nbsp;7 | *Comparison of different materialization strategies in CRDV, based on the workload.* |
| `plan_optimization` | Listing 3 | *Physical plans for different CRDV queries.* |
| `nested_structures` | Figure&nbsp;8 | *CRDV’s read performance with different levels of nesting.* |
| `operations` | Figure&nbsp;9 | *Performance comparison between different operations in different structures, using different solutions.* |
| `concurrency` | Figure&nbsp;10 | *Write performance of different solutions in a variable contention workload.* |
| `storage_structures` | Figure&nbsp;11 | *Storage usage and latency of different solutions, based on the total number of maps.* |
| `storage_sites` | Figure&nbsp;12 | *Storage usage based on the number of sites.* |
| `network` | Figure&nbsp;13 | *Network overhead of different distributed solutions.* |
| `freshness` | Figure&nbsp;14 | *Delay and throughput over time of different distributed solutions.* |
| `multiple_sites` | Figure&nbsp;15 | *Performance comparison based on the cluster size.* |


## Configuration

The default configuration uses the same parameters as the paper. To use different parameters, the respective configuration files located at `conf/` can be updated.

### Lite tests

To obtain results quicker, we provide versions of the configurations with reduced execution times, number of repeated runs, and X-axis values. Although faster, we expect the conclusions to remain the same.

To use the smaller configurations:

```shell
# backup the default configuration
cp -r conf conf_default
# set the new configuration
cp conf_lite/* conf
```

To restore the default configuration:
```shell
cp conf_default/* conf
```

### Nano tests

Nano tests can be used to confirm that the setup, all tests, and document generation run correctly. Estimated runtime: 30 minutes.

> [!IMPORTANT] 
> The nano tests should only be used to confirm that everything is working correctly and not to retrieve meaningful results. The execution times are too short and some tests/figures are missing. Some warnings will appear in the output, but the final PDF should be generated.


```shell
# backup the default configuration
cp -r conf conf_default
# set the new configuration
cp conf_nano/* conf
```

To restore the default configuration:
```shell
cp conf_default/* conf
```


## Differences from the paper

- For ease of use, these reproducibility scripts use Docker to deploy multiple sites. In the paper, however, this was accomplished using native deployments on multiple AWS virtual machines, each with its dedicated resources (CPU, Mem, Disk). This means that the order of magnitude of the results might be different, especially for the `multiple_sites` test, where each site is limited to 1 vCPU - to evaluate the scalability - and all sites share the same disk. However, we still expect the results to match the paper's conclusions.
- Since the `freshness` tests with Pg_crdt can consume large amounts of memory, they might stop early when running with many clients. To prevent this, the system should have swap enabled. However, it is not critical for the paper's conclusions.
