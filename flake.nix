{
  description = "Reverse-engineer OpenSpec specifications from existing codebases";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "spec-gen";
            version = "1.0.0";

            src = ./.;

            npmDepsHash = "sha256-5l/gdzyivfA5w5/0GA5vte3NY7AMfoFsqMvWgkzfM1A=";

            # Build TypeScript
            buildPhase = ''
              runHook preBuild
              npm run build
              runHook postBuild
            '';

            # Install the built package
            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/node_modules/spec-gen
              cp -r dist package.json $out/lib/node_modules/spec-gen/

              # Copy node_modules for runtime dependencies
              cp -r node_modules $out/lib/node_modules/spec-gen/

              # Create bin wrapper (ESM — must use import(), not require())
              mkdir -p $out/bin
              cat > $out/bin/spec-gen <<EOF
              #!${pkgs.nodejs}/bin/node
              import('../lib/node_modules/spec-gen/dist/cli/index.js');
              EOF
              # Remove leading whitespace from heredoc (including the shebang line)
              sed -i 's/^[[:space:]]*//' $out/bin/spec-gen
              chmod +x $out/bin/spec-gen

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Reverse-engineer OpenSpec specifications from existing codebases";
              homepage = "https://github.com/clay-good/spec-gen";
              license = licenses.mit;
              maintainers = [ ];
              mainProgram = "spec-gen";
              platforms = platforms.all;
            };
          };

          spec-gen = self.packages.${system}.default;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/spec-gen";
        };

        spec-gen = self.apps.${system}.default;
      });

      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [
              nodejs_22
              nodePackages.npm
              nodePackages.typescript
              nodePackages.typescript-language-server
            ];

            shellHook = ''
              echo "spec-gen development environment"
              echo "Node.js version: $(node --version)"
              echo "npm version: $(npm --version)"
            '';
          };
        }
      );
    };
}
