// A SEPARATE module on purpose — see the package doc in projection.go.
//
// `github.com/bitspark/ontos` itself has NO dependencies, and that is a property of an
// opinion-free substrate rather than an accident. Folding this package into the main
// module would put `deixis` into the module graph of every ontos consumer, including
// those importing only `core`. The Rust side keeps the same boundary by making the
// face its own crate (`ontos-deixis-projection`), whose description states the intent:
// "Additive; the one place in ontos that knows deixis exists."
module github.com/bitspark/ontos/projection/deixis/go

go 1.25

require (
	github.com/bitspark/deixis v0.6.0
	github.com/bitspark/ontos v0.13.0
)

replace github.com/bitspark/ontos => ../../..
