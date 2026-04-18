/** PM2 process file — adjust `cwd` to your machine path */
module.exports = {
  apps: [
    {
      name: "trading-bot",
      script: "dist/index.js",
      cwd: __dirname,
      interpreter: "node",
      env_file: ".env",
      autorestart: true,
      max_restarts: 50,
      min_uptime: "10s",
    },
    {
      name: "evening-analyst",
      script: "dist/analyst.js",
      cwd: __dirname,
      interpreter: "node",
      env_file: ".env",
      autorestart: false,
      cron_restart: "45 15 * * 1-5",
      timezone: "Asia/Kolkata",
    },
    {
      name: "nightly-discovery",
      script: "dist/discovery-sync.js",
      args: "--top 10 --days 5",
      cwd: __dirname,
      interpreter: "node",
      env_file: ".env",
      autorestart: false,
      cron_restart: "20 18 * * 1-5",
      timezone: "Asia/Kolkata",
    },
  ],
};
