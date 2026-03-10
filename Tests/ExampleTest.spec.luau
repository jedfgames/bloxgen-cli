--[[

ExampleTest

Example test to demonstrate the testing framework.

--]]

return function()
    describe("Example", function()
        it("should pass a basic assertion", function()
            expect(1 + 1).to.equal(2)
        end)

        it("should handle string comparisons", function()
            expect("hello").to.equal("hello")
        end)
    end)
end
