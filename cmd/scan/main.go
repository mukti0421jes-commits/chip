// Command scan resolves the RJ SLOT cipher configuration from a site JS bundle.
//
// Usage:
//
//	go run ./cmd/scan path/to/bundle.js
//
// It prints the resolved key/skip/length/version for each purpose (sign-in,
// reserve, initiate/dg-epay), applies them to the cipher package, and shows a
// sample encryption so the config can be sanity-checked end to end.
package main

import (
	"fmt"
	"os"

	"github.com/mukti0421jes-commits/chip/cipher"
	"github.com/mukti0421jes-commits/chip/scanner"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: scan <bundle.js>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "read bundle:", err)
		os.Exit(1)
	}

	cfg, err := scanner.ScanBundle(string(data))
	if err != nil {
		fmt.Fprintln(os.Stderr, "scan:", err)
		os.Exit(1)
	}

	printPurpose("sign-in ", cfg.Signin)
	printPurpose("reserve ", cfg.Reserve)
	printPurpose("initiate", cfg.Initiate)

	if !cfg.Apply() {
		fmt.Println("\nNo config resolved from this bundle.")
		return
	}

	sample := "abc123XYZ_-456defGHIjkl789MNOpqr0stuvwx"
	fmt.Println("\nSample token :", sample)
	fmt.Println("  sign-in enc:", cipher.ProcessTokenSignin(sample))
	fmt.Println("  reserve enc:", cipher.ProcessTokenReserveSlot(sample))
	fmt.Println("  initiate enc:", cipher.ProcessTokenInitiate(sample))
}

func printPurpose(name string, pc *scanner.PurposeConfig) {
	if pc == nil {
		fmt.Printf("[%s] not resolved\n", name)
		return
	}
	fmt.Printf("[%s] v%d skip=%d len=%d key[%d]=%s\n",
		name, pc.Version, pc.Skip, pc.Length, len(pc.Key), pc.Key)
}
