Feature: Import from Claude Code
  As someone who has worked in Claude Code
  I want to bring those sessions into Threadbear as threads
  So I can carry on the same conversations here

  # GPUI-only: the Swift app is frozen and hasn't got the sheet, so every
  # scenario here is @swift-pending. The mock runner offers four sessions:
  # one from the CLI, one the Claude desktop app knows, one it archived, and
  # one whose folder isn't on this Mac, and a session that Stagehand
  # started, which sits under it.

  Background:
    Given the app is connected to a runner with the demo threads

  @menu.importclaudecode @swift-pending
  Scenario: File > Import from Claude Code opens a list of the sessions that aren't threads yet
    Then the "File" menu lists "New Thread | Import from Claude Code… | Close"
    When I open the Import from Claude Code sheet
    Then the import sheet lists "Add a dark mode toggle"
    And the import sheet lists "Stagehand"
    And the import sheet does not list "Fix the footer links"
    And the import sheet's button is "Import" and can't be pressed

  @menu.importclaudecode @swift-pending
  Scenario: Archived sessions come into the list when asked for
    When I open the Import from Claude Code sheet
    And I show archived sessions in the import sheet
    Then the import sheet lists "Fix the footer links"

  @menu.importclaudecode @swift-pending
  Scenario: Ticked sessions come in as threads, and one that can't says why under its row
    When I open the Import from Claude Code sheet
    And I tick "Add a dark mode toggle" and "Try the old prototype" in the import sheet
    Then the import sheet's button is "Import 2 sessions" and can be pressed
    When I press Import in the import sheet
    Then the import sheet's row "Add a dark mode toggle" is imported
    And the import sheet's row "Try the old prototype" says "isn't on this Mac"
    And the sidebar lists "Add a dark mode toggle"

  @menu.importclaudecode @swift-pending
  Scenario: Select all ticks every listed session
    When I open the Import from Claude Code sheet
    And I select all in the import sheet
    Then the import sheet's button is "Import 4 sessions" and can be pressed

  @menu.importclaudecode @swift-pending
  Scenario: A session that started another brings it in too, nested under it
    When I open the Import from Claude Code sheet
    Then the import sheet lists "Scene tree worker" under "Stagehand"
    When I tick "Stagehand" in the import sheet
    Then the import sheet's row "Scene tree worker" comes along
    When I press Import in the import sheet
    Then the import sheet's row "Scene tree worker" is imported
