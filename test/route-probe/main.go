// Command route-probe reports which outbound the pinned Mihomo core picks for
// each connection, using the core's own config parser, rules and groups.
// It reads one JSON request on stdin and writes one JSON response on stdout.
// It never opens a listener, dials a proxy, resolves DNS or downloads a
// provider: only inline and file rule-providers carry rules here.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/netip"
	"os"

	"github.com/metacubex/mihomo/adapter/outboundgroup"
	"github.com/metacubex/mihomo/config"
	C "github.com/metacubex/mihomo/constant"
	P "github.com/metacubex/mihomo/constant/provider"
	"github.com/metacubex/mihomo/hub/executor"
	"github.com/metacubex/mihomo/tunnel"
	"github.com/sirupsen/logrus"
)

type probeCase struct {
	Network string `json:"network"`
	Host    string `json:"host"`
	Port    uint16 `json:"port"`
}

type request struct {
	Config json.RawMessage `json:"config"`
	// Select picks a member in select groups before routing, as a user tap would.
	Select  map[string]string `json:"select"`
	Cases   []probeCase       `json:"cases"`
	Members []string          `json:"members"`
}

type selectable interface {
	Set(name string) error
}

type caseResult struct {
	Outbound string `json:"outbound"`
	Rule     string `json:"rule"`
	// DNS lookups the rules asked for; only counted when the host is a domain.
	Resolutions int `json:"resolutions"`
}

type response struct {
	Cases   []caseResult        `json:"cases"`
	Members map[string][]string `json:"members"`
	// Rules each file rule-provider loaded. The core skips a line it cannot
	// parse with only a warning, so a reshaped upstream file shows up here.
	Loaded map[string]int `json:"loaded"`
}

// route mirrors the rule loop in tunnel.match: the first matching rule wins,
// except that UDP skips a rule whose outbound cannot carry UDP.
func route(cfg *config.Config, probe probeCase) caseResult {
	metadata := &C.Metadata{NetWork: C.TCP, Host: probe.Host, DstPort: probe.Port}
	if probe.Network == "udp" {
		metadata.NetWork = C.UDP
	}
	// tunnel.fixMetadata turns an IP literal host into the destination IP.
	if ip, err := netip.ParseAddr(probe.Host); err == nil {
		metadata.DstIP = ip.Unmap()
		metadata.Host = ""
	}
	result := caseResult{Outbound: "DIRECT", Rule: "(no match)"}
	helper := C.RuleMatchHelper{ResolveIP: func() {
		if !metadata.DstIP.IsValid() {
			result.Resolutions++
		}
	}}
	for _, rule := range cfg.Rules {
		matched, name := rule.Match(metadata, helper)
		if !matched {
			continue
		}
		outbound, ok := cfg.Proxies[name]
		if !ok {
			continue
		}
		if metadata.NetWork == C.UDP && !outbound.SupportUDP() {
			continue
		}
		result.Outbound = name
		result.Rule = fmt.Sprintf("%s,%s", rule.RuleType(), rule.Payload())
		return result
	}
	return result
}

func run() error {
	home := flag.String("d", "", "Mihomo home directory for geodata; required so the user's own is never touched")
	flag.Parse()
	if *home == "" {
		return errors.New("-d is required")
	}
	C.SetHomeDir(*home)
	// Mihomo logs to stdout by default; keep stdout for the JSON response.
	logrus.SetOutput(os.Stderr)

	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		return fmt.Errorf("decode request: %w", err)
	}
	cfg, err := executor.ParseWithBytes(req.Config)
	if err != nil {
		return fmt.Errorf("parse config: %w", err)
	}
	// File rule-providers stand in for downloaded upstream lists. Load them the
	// way the core does at startup, so their real format is parsed; an http
	// provider is never loaded.
	loaded := map[string]int{}
	for name, provider := range cfg.RuleProviders {
		if provider.VehicleType() == P.File {
			if err := provider.Initial(); err != nil {
				return fmt.Errorf("load rule-provider %s: %w", name, err)
			}
			loaded[name] = provider.Count()
		}
	}
	tunnel.UpdateRules(cfg.Rules, cfg.SubRules, cfg.RuleProviders)
	tunnel.UpdateProxies(cfg.Proxies, cfg.Providers)

	for group, member := range req.Select {
		proxy, ok := cfg.Proxies[group]
		if !ok {
			return fmt.Errorf("group %s not found", group)
		}
		selector, ok := proxy.Adapter().(selectable)
		if !ok {
			return fmt.Errorf("%s is not a select group", group)
		}
		if err := selector.Set(member); err != nil {
			return fmt.Errorf("select %s in %s: %w", member, group, err)
		}
	}

	res := response{Members: map[string][]string{}, Loaded: loaded}
	for _, probe := range req.Cases {
		res.Cases = append(res.Cases, route(cfg, probe))
	}
	for _, name := range req.Members {
		proxy, ok := cfg.Proxies[name]
		if !ok {
			return fmt.Errorf("group %s not found", name)
		}
		group, ok := proxy.Adapter().(outboundgroup.ProxyGroup)
		if !ok {
			return fmt.Errorf("%s is not a group", name)
		}
		names := []string{}
		for _, member := range group.Proxies() {
			names = append(names, member.Name())
		}
		res.Members[name] = names
	}
	return json.NewEncoder(os.Stdout).Encode(res)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
