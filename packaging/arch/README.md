# Arch Linux package

`PKGBUILD` installs the prebuilt Linux x86_64 release of Theorem.
Nothing is compiled: it downloads the release .deb from GitHub, checks its SHA-256 and
unpacks it.

```bash
git clone https://github.com/Fundaments-Work/Theorem.git
cd Theorem/packaging/arch
makepkg -si
```

To publish it to the AUR as `theorem-bin` once an account exists: copy `PKGBUILD`
and `.SRCINFO` into the AUR git repository for `theorem-bin`. On each new release,
change `pkgver` and the checksums together, run `makepkg -g` for the new
sums, then regenerate `.SRCINFO` with `makepkg --printsrcinfo > .SRCINFO`.
