cask "theorem" do
  version "1.4.3"

  on_arm do
    sha256 "54ba673e9ffab8eb3552bc1a136f4124dbc1570815ee0d3de10ea7e747ce28e4"
    url "https://github.com/Fundaments-Work/Theorem/releases/download/v#{version}/Theorem_#{version}_aarch64.dmg"
  end

  on_intel do
    sha256 "0ac3390c4c0b843c1143d3e588d98e5e90e6db28390283e16158202d5ca0b6a6"
    url "https://github.com/Fundaments-Work/Theorem/releases/download/v#{version}/Theorem_#{version}_x64.dmg"
  end

  name "Theorem"
  desc "Local-first EPUB/PDF/MOBI reader with highlights, TTS and Markdown export"
  homepage "https://theorem.fundaments.work"

  depends_on macos: ">= :big_sur"

  app "Theorem.app"

  zap trash: [
    "~/Library/Application Support/work.fundamentals.theorem",
    "~/Library/Caches/work.fundamentals.theorem",
    "~/Library/Preferences/work.fundamentals.theorem.plist",
    "~/Library/Saved Application State/work.fundamentals.theorem.savedState",
  ]
end
