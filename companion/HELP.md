# OnCue

Control OnCue's Timer, Teleprompter, and Audio Player modules from Bitfocus Companion.

[OnCue](https://timernegativo.netlify.app) is a live-event production suite (Timer, Teleprompter, Audio Player) built for Windows. This module connects to it over your local network and lets Companion trigger and monitor it in real time.

## Setup

1. In OnCue, keep the Timer, Teleprompter, and/or Player windows open on the computer you want to control — this module talks to whichever ones are open.
2. In Companion, add a new connection using this module.
3. Set **IP** to the local network address of the computer running OnCue (e.g. `192.168.1.50`). Use `127.0.0.1` if Companion runs on the same machine.
4. Leave **Port** at its default unless you changed it in OnCue.
5. The connection status should turn green once OnCue is reachable.

## Actions

**Timer**
- Start / Pause / Stop / Reset (reset returns to the configured time)
- Set Time (hours/minutes/seconds)
- Add Time / Subtract Time (10s, 30s, 1min, 2min, 5min, 10min)
- Send Message to the display / Clear Message
- Switch to Countdown mode / Switch to Count-up mode
- Enable / Disable / Toggle blink-on-expire
- Enable / Disable / Toggle negative counting (counts past zero instead of stopping at 00:00)

**Teleprompter**
- Play / Pause / Play-Pause toggle / Return to start
- Set Speed (absolute)
- Adjust Speed (relative — for a jog wheel or rotary encoder)
- Toggle mirror

**Player**
- Play / Pause / Play-Pause toggle / Next track / Previous track
- Set Volume (absolute) / Adjust Volume (relative — for a jog wheel or rotary encoder)
- Fade Out
- Toggle shuffle / Cycle repeat mode
- Play Track by Name
- Play Pad (1–9)
- Set Pad Volume (absolute) / Adjust Pad Volume (relative)

## Feedbacks

- Timer: Running / Paused / Stopped
- Timer: Time's Up (blinks red)
- Timer: Alert 1 (yellow) / Alert 2 (red) — trigger when the countdown crosses your configured thresholds
- Timer: Blink-on-expire enabled
- Timer: Negative counting enabled
- Teleprompter: Playing
- Player: Playing
- Player: Pad Playing (choose which pad, 1–9)

## Variables

| Variable | Description |
| --- | --- |
| `timer_time` | Current time (HH:MM:SS, or `-MM:SS` once expired with negative counting on) |
| `timer_status` | Timer status |
| `timer_message` | Current message shown on the timer display |
| `timer_mode` | `countdown` or `countup` |
| `tp_status` | Teleprompter status (`playing`/`paused`) |
| `tp_speed` | Current teleprompter speed |
| `player_track` | Current track name |
| `player_status` | Player status (`playing`/`paused`) |
| `player_volume` | Player volume (%) |

## Notes

- OnCue and Companion need to be on the same local network. No internet connection is required.
- This module was built for OnCue's own Timer/Teleprompter/Player modules and does not control third-party software.
