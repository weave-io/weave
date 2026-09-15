# slugctl

Turns text into a URL slug.

```sh
slugctl [--separator <sep>] <text...>
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--separator <sep>` | `-` | String placed between words |
| `--help` | | Print usage |

Examples:

```sh
$ slugctl "Hello, World!"
hello-world
$ slugctl --separator _ "Hello World"
hello_world
```
