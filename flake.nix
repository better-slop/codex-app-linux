{
  description = "codex-app-linux build shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        releaseProd = pkgs.writeShellApplication {
          name = "release-prod";
          runtimeInputs = with pkgs; [ nodejs_24 p7zip libarchive gnutar ];
          text = ''
            cd ${self}
            exec node scripts/release-channel.mjs --channel prod "$@"
          '';
        };
        releaseBeta = pkgs.writeShellApplication {
          name = "release-beta";
          runtimeInputs = with pkgs; [ nodejs_24 p7zip libarchive gnutar ];
          text = ''
            cd ${self}
            exec node scripts/release-channel.mjs --channel beta "$@"
          '';
        };
      in
      {
        packages.release-prod = releaseProd;
        packages.release-beta = releaseBeta;
        apps.release-prod = {
          type = "app";
          program = "${releaseProd}/bin/release-prod";
        };
        apps.release-beta = {
          type = "app";
          program = "${releaseBeta}/bin/release-beta";
        };
        apps.default = self.apps.${system}.release-prod;
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            git
            gh
            jq
            p7zip
            libarchive
            gnutar
          ];
        };
      });
}
