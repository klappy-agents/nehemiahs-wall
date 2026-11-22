// HYGIENE 19: one version, one place. package.json is the manifest; everything that prints a version reads it here.
import pkg from "../package.json" with { type: "json" };
export const VERSION = pkg.version;
