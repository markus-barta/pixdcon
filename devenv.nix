{ pkgs, ... }: {
  packages = [
    pkgs.nodejs_20
    pkgs.git
    pkgs.gh
  ];

  scripts.exec = "node src/index.js";
}
