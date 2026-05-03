# MechVibes++ 2026 Known Issues

## No soundpacks showing up after fresh install

### On Windows

- Download [Visual C++ Redistributable 2015-2022](https://aka.ms/vs/17/release/vc_redist.x64.exe)
  - If it says error, read the info. It may already be installed.
- Restart MechVibes++ 2026.
- Restart your computer.

### On macOS

- Go to Privacy in System Settings.
- Check for MechVibes++ 2026 in any of the categories and enable any permissions.
- Restart MechVibes++ 2026.

## No soundpacks showing up after adding a soundpack

In most cases, this bug happens if you have incorrectly added a soundpack. Below is a list with things that can cause this bug to occur.

**Known Causes**

- Adding or leaving an empty folder in `mechvibes_custom`
- Having a folder inside a folder
- Editing `config.json` incorrectly
- Having `.zip` or `.rar` files in `mechvibes_custom`

**If all else fails**

Sometimes the custom folder breaks. Remove the entire folder and reload. A new one will automatically be created once you restart the app.
