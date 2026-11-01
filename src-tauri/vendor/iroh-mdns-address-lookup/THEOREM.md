# Theorem's local patch

Source: `iroh-mdns-address-lookup` 0.6.0 as published on crates.io, from
<https://github.com/n0-computer/iroh-address-lookups>. Copyright 2025 N0, INC.;
licensed MIT OR Apache-2.0. The upstream source, tests, example and normalized
manifest are retained here.

The patch tracks IPv4 addresses in endpoint publications and calls
`DropGuard::add_interface_v4` / `remove_interface_v4` as interfaces appear and
disappear. `swarm-discovery` must be at least 0.6.3, whose per-interface handling
both joins the main receive socket and pins outgoing multicast. Its default
configuration only joins/sends on the default-route interface. Updating the
advertised address records does not change multicast interface membership.

This fixes discovery over a laptop-hosted hotspot that is not the default route.
Public NAT candidates are handled best-effort by swarm-discovery: addresses
that cannot be bound locally do not get an interface socket. IPv6 retains
upstream's default-interface behavior.

The Linux regression scenario in `src/sync_scenarios.rs` receives multicast
only on loopback (`IP_MULTICAST_ALL=0`) and exchanges data between real paired
nodes using a locally discovered address, without a relay or internet lookup:

```sh
cargo test --lib paired_devices_sync_on_a_non_default_interface_without_internet
```

When upgrading, compare this source against the new upstream release and remove
the Cargo patch once upstream tracks multicast interfaces itself. Do not edit
the copy in the Cargo registry.
