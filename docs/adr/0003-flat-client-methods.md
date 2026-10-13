# 0003: Client method arguments

The client exposes flat method names without aliases. Methods with arguments take `(ctx, args)`, where `args` is an object. `getPublicKey` and `selfTest` take only `ctx`.
