using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using FireMap.Web.Models;

namespace FireMap.Web.Controllers;

public class HomeController : Controller
{
    /// <summary>The map application shell; everything else is the JS frontend + /api.</summary>
    public IActionResult Index() => View();

    [ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
    public IActionResult Error() =>
        View(new ErrorViewModel { RequestId = Activity.Current?.Id ?? HttpContext.TraceIdentifier });
}
