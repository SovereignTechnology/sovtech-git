# Temporary security update until the pinned Nixpkgs includes JDK 21.0.13.
# Reuse Nixpkgs' native binary packaging for Linux and Apple Silicon.
final: previous:
let
  sources = {
    x86_64-linux = {
      arch = "x86_64";
      file = "OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz";
      sha256 = "d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c";
    };
    aarch64-linux = {
      arch = "aarch64";
      file = "OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.13_9.tar.gz";
      sha256 = "e3522e707fc7dbe2a72c30746b1e7068301a0213ecd213d4491f35a14eb55578";
    };
    aarch64-darwin = {
      arch = "aarch64";
      file = "OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.13_9.tar.gz";
      sha256 = "bf036b35b071bfb2f54f2c0af8ee8d88afa95ee6eb3dce02c0f94cfc2524d04a";
    };
  };
  source = sources.${previous.stdenv.hostPlatform.system};
  platform = if previous.stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  recipe = previous.path + "/pkgs/development/compilers/temurin-bin/jdk-${platform}-base.nix";
in
{
  jdk21 = previous.callPackage (import recipe {
    sourcePerArch = {
      packageType = "jdk";
      ${source.arch} = {
        version = "21.0.13+9";
        url = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/${source.file}";
        inherit (source) sha256;
      };
    };
  }) { };
}
