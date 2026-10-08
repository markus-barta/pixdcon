{ pkgs, ... }: {
  packages = [
    pkgs.nodejs_22
    pkgs.git
    pkgs.gh
  ];

  scripts.exec.exec = "node src/index.js";
}
