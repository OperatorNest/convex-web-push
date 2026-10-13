# 0001: Optional property checking

`exactOptionalPropertyTypes` is off in the package because convex-helpers' TypeScript pagination source rejects that setting. `skipLibCheck` does not skip imported TypeScript source. The example enables the setting. Enable it in the package when the upstream pagination source compiles with it.
