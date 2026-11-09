# AI Pace in Waybar

1. Copy the script and put your URL and token in it:

   ```bash
   mkdir -p ~/.config/waybar/scripts
   cp clients/waybar/ai-pace.sh ~/.config/waybar/scripts/
   chmod 700 ~/.config/waybar/scripts/ai-pace.sh
   # edit AIPACE_URL and AIPACE_TOKEN at the top of the file (`npm run token` prints the token)
   ```

2. In `~/.config/waybar/config.jsonc`, add `"custom/ai-pace"` to `modules-right` (or wherever you like) and define it:

   ```jsonc
   "custom/ai-pace": {
     "exec": "~/.config/waybar/scripts/ai-pace.sh",
     "return-type": "json",
     "interval": 300,
     "tooltip": true,
     "on-click": "xdg-open http://localhost:8787/"
   }
   ```

3. Optionally, in `~/.config/waybar/style.css`:

   ```css
   #custom-ai-pace { padding: 0 8px; }
   #custom-ai-pace.over, #custom-ai-pace.limit, #custom-ai-pace.alert { font-weight: bold; }
   ```

4. Reload Waybar (`omarchy-restart-waybar` on omarchy, or `killall -SIGUSR2 waybar`).

CSS classes follow the worst status across providers: `over`, `limit`, `on_pace`, `under`, `idle`, `unknown`, plus `alert`
(something needs action, e.g. credits about to expire) and `error` (server unreachable).
