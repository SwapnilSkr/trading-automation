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
  ],
};
