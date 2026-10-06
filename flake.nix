{
  description = "pi/omp extension for doeixd's OptMem project-scoped agent memory";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      imports = [ inputs.flake-parts.flakeModules.partitions ];

      perSystem =
        { lib, pkgs, ... }:
        let
          manifest = lib.importJSON ./package.json;
        in
        {
          # The installable extension package: the directory pi/omp load via
          # `omp install <path>` or `pi install <path>`.
          packages.default = pkgs.stdenvNoCC.mkDerivation {
            pname = manifest.name;
            inherit (manifest) version;

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./extension.ts
                ./package.json
                ./README.md
                ./LICENSE
              ];
            };

            dontBuild = true;
            doCheck = true;
            nativeCheckInputs = [ pkgs.bun ];
            # Transpile without bundling: rejects syntax errors without
            # needing the host-provided peer dependencies.
            checkPhase = ''
              runHook preCheck
              bun build --no-bundle --target=node extension.ts > /dev/null
              runHook postCheck
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp extension.ts package.json README.md LICENSE $out/
              runHook postInstall
            '';

            meta = {
              inherit (manifest) description;
              inherit (manifest) homepage;
              license = lib.licenses.bsd0;
              platforms = lib.platforms.all;
            };
          };
        };

      # Development tools do not enter the input closure of package consumers.
      partitionedAttrs = {
        checks = "dev";
        devShells = "dev";
        formatter = "dev";
      };

      partitions.dev = {
        extraInputsFlake = ./dev;
        module = import ./nix/flake/dev-partition.nix;
      };
    };
}
