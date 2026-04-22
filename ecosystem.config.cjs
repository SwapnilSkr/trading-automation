/** PM2 process file — adjust `cwd` to your machine path */
module.exports = {
  apps: [
    {
      name: "trading-bot",
      script: "/Users/fatman/.bun/bin/bun",
      args: "dist/index.js",
      cwd: __dirname,
      interpreter: "none",
      env_file: ".env",
      autorestart: true,
      max_restarts: 50,
      min_uptime: "10s",
    },
  ],
};
