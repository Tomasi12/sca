/* Expected finding: division by zero at line 6 (y can be 0). */
int divide(int x, int y)
{
    if (y >= 0)
    {
        return x / y;
    }
    return 0;
}
