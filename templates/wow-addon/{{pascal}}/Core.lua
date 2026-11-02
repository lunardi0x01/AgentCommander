local addonName = ...

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(_, _, name)
    if name ~= addonName then return end
    {{pascal}}DB = {{pascal}}DB or {}
    print("|cff33ff99{{name}}|r loaded")
end)
